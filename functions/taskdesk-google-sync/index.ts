// Supabase Edge Function: taskdesk-google-sync
//
// Two-way reconciliation between a taskdesk sync group's tasks and its
// dedicated "タスクデスク" Google Calendar (created by
// taskdesk-google-oauth-callback on first connect). Called by the client
// periodically and after local edits, passing just {syncId} in the body -
// no client-supplied task list. Instead this function reads the CURRENT
// tasks straight out of taskdesk_state (the same row the client's own
// cross-device sync already keeps up to date) and writes the reconciled
// result back to that same row. The client doesn't need any special
// handling for the result: its existing 30s taskdesk_state poll picks up
// whatever this function wrote, through the same merge path as any other
// device's push.
//
// Sync scope: only the dedicated calendar is touched - nothing else on the
// user's other calendars is read or written. A task is "eligible" to have
// a calendar event when it's triaged, has a dueDate, and isn't done.
//
// Conflict rule: each task tracks `touchedAt` (bumped on any local edit)
// and `googleSyncedAt` (last time this function reconciled that task).
// Google's own `updated` timestamp on the event plays the same role for
// the remote side. Whichever of the two changed more recently since the
// last reconciliation wins; if only one side changed, that side's version
// is applied to the other.
//
// Deploy via the Supabase Dashboard (Edge Functions > Deploy a new function
// > Via Editor). Turn OFF "Enforce JWT Verification" - taskdesk has no
// login, so there's no Supabase Auth JWT to check; the sync code in the
// request body is the only access control, same trust model as
// taskdesk_state's anon RLS policy. Requires the same TASKDESK_GOOGLE_CLIENT_ID /
// TASKDESK_GOOGLE_CLIENT_SECRET secrets as taskdesk-google-oauth-callback.

import { createClient } from 'npm:@supabase/supabase-js@2';

const GOOGLE_CLIENT_ID = Deno.env.get('TASKDESK_GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('TASKDESK_GOOGLE_CLIENT_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('token refresh failed: ' + (await res.text()));
  return (await res.json()).access_token;
}

async function gcal(accessToken: string, calendarId: string, method: string, path: string, body?: unknown) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }
  );
  if (res.status === 404 || res.status === 410) return null; // event/calendar gone on Google's side
  if (res.status === 204) return {};
  if (!res.ok) throw new Error(`Google Calendar ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listAllEvents(accessToken: string, calendarId: string) {
  const events: any[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ maxResults: '250', singleEvents: 'true' });
    if (pageToken) qs.set('pageToken', pageToken);
    const page = await gcal(accessToken, calendarId, 'GET', `/events?${qs.toString()}`);
    if (!page) break;
    events.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

const TIME_ZONE = 'Asia/Tokyo';

function eventDateFields(startDate: string, startTime: string | null) {
  if (startTime) {
    // ローカル時刻文字列をそのまま渡し、timeZoneで明示する
    // (timeZoneを省略するとGoogle Calendar APIが400を返す)。
    const start = { dateTime: `${startDate}T${startTime}:00`, timeZone: TIME_ZONE };
    const end = { dateTime: `${startDate}T${startTime}:00`, timeZone: TIME_ZONE }; // 30分イベントにする
    const [h, m] = startTime.split(':').map(Number);
    const endMinutes = h * 60 + m + 30;
    const endH = Math.floor(endMinutes / 60) % 24;
    const endM = endMinutes % 60;
    end.dateTime = `${startDate}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;
    return { start, end };
  }
  const addDay = (d: string) => {
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  };
  return { start: { date: startDate }, end: { date: addDay(startDate) } };
}

// Deno Edge Functionの実行環境はUTC基準で動いているため、Date#getHours()等の
// "ローカル時刻" はUTCになってしまう。一度Intl.DateTimeFormat(timeZone指定)で
// 直そうとしたが、この実行環境ではICUデータの都合か効かなかったため、
// 日本時間には夏時間が無いことを利用して単純にUTC+9時間を足す方式にする
// (ICU/Intlに依存しないので確実)。
function fieldsFromEvent(ev: any): { title: string; note: string; dueDate: string | null; dueTime: string | null } {
  const title = ev.summary || '(無題)';
  const note = ev.description || '';
  if (ev.start?.date) return { title, note, dueDate: ev.start.date, dueTime: null };
  if (ev.start?.dateTime) {
    const jst = new Date(new Date(ev.start.dateTime).getTime() + 9 * 60 * 60 * 1000);
    const dueDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
    const dueTime = `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
    return { title, note, dueDate, dueTime };
  }
  return { title, note, dueDate: null, dueTime: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  try {
    const body = await req.json().catch(() => ({}));
    const syncId: string | undefined = body?.syncId;
    if (!syncId) {
      return new Response(JSON.stringify({ error: 'missing syncId' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: account } = await sb
      .from('taskdesk_google_accounts')
      .select('refresh_token, calendar_id')
      .eq('id', syncId)
      .maybeSingle();
    if (!account) {
      return new Response(JSON.stringify({ connected: false }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const { data: stateRow } = await sb.from('taskdesk_state').select('data').eq('id', syncId).maybeSingle();
    if (!stateRow?.data) {
      return new Response(JSON.stringify({ connected: true, updated: 0, note: 'no taskdesk_state row yet' }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const data = stateRow.data;
    const tasks: any[] = Array.isArray(data.tasks) ? data.tasks : [];
    const pendingDeletes: string[] = Array.isArray(data.pendingGoogleDeletes) ? data.pendingGoogleDeletes : [];

    const accessToken = await refreshAccessToken(account.refresh_token);
    const calendarId = account.calendar_id;

    // クライアント側でタスクごと削除された分は、まずGoogle側のイベントを消しておく。
    // ここより後でイベント一覧を取ると、消し忘れたイベントが「孤立イベント」として
    // 新しいタスクに復活してしまう(実際に起きた不具合)。
    for (const eventId of pendingDeletes) {
      await gcal(accessToken, calendarId, 'DELETE', `/events/${eventId}`);
    }

    const events = await listAllEvents(accessToken, calendarId);
    const eventById = new Map(events.map((e) => [e.id, e]));

    const now = Date.now();
    let counter = data.counter || 0;
    const nextTasks: any[] = [];
    const seenEventIds = new Set<string>();

    for (const t of tasks) {
      const eligible = !!(t.triaged && t.dueDate && t.status !== 'done');

      if (t.googleEventId && !eventById.has(t.googleEventId)) {
        // Google側で削除された -> こちら側のタスクも削除する
        continue;
      }

      if (!eligible) {
        if (t.googleEventId) {
          await gcal(accessToken, calendarId, 'DELETE', `/events/${t.googleEventId}`);
        }
        nextTasks.push({ ...t, googleEventId: null, googleSyncedAt: null });
        continue;
      }

      if (!t.googleEventId) {
        const { start, end } = eventDateFields(t.dueDate, t.dueTime);
        const created = await gcal(accessToken, calendarId, 'POST', '/events', {
          summary: t.title, description: t.note || '', start, end,
        });
        seenEventIds.add(created.id);
        nextTasks.push({ ...t, googleEventId: created.id, googleSyncedAt: now, touchedAt: t.touchedAt || now });
        continue;
      }

      const gEvent = eventById.get(t.googleEventId)!;
      seenEventIds.add(gEvent.id);
      const gUpdatedMs = Date.parse(gEvent.updated || '') || 0;
      const localChanged = (t.touchedAt || 0) > (t.googleSyncedAt || 0);
      const remoteChanged = gUpdatedMs > (t.googleSyncedAt || 0);

      if (localChanged && (!remoteChanged || (t.touchedAt || 0) >= gUpdatedMs)) {
        const { start, end } = eventDateFields(t.dueDate, t.dueTime);
        await gcal(accessToken, calendarId, 'PATCH', `/events/${gEvent.id}`, {
          summary: t.title, description: t.note || '', start, end,
        });
        nextTasks.push({ ...t, googleSyncedAt: now });
      } else if (remoteChanged) {
        const fields = fieldsFromEvent(gEvent);
        nextTasks.push({
          ...t,
          title: fields.title, note: fields.note,
          dueDate: fields.dueDate || t.dueDate, dueTime: fields.dueTime,
          googleSyncedAt: now, touchedAt: now,
        });
      } else {
        nextTasks.push({ ...t, googleSyncedAt: now });
      }
    }

    // カレンダー側にあるが、どのタスクにも紐付いていないイベント -> 新規タスクとして取り込む
    for (const ev of events) {
      if (seenEventIds.has(ev.id)) continue;
      if (ev.status === 'cancelled') continue;
      const fields = fieldsFromEvent(ev);
      if (!fields.dueDate) continue;
      counter += 1;
      nextTasks.unshift({
        id: counter, no: 'No.' + String(counter).padStart(3, '0'),
        title: fields.title, note: fields.note, createdAt: now, triaged: true,
        urgent: false, important: false, status: 'todo', estPomodoros: 2, donePomodoros: 0, completedAt: null,
        dueDate: fields.dueDate, dueTime: fields.dueTime, reminderMin: null, notifiedAt: null, repeat: null,
        googleEventId: ev.id, googleSyncedAt: now, touchedAt: now,
      });
    }

    const newData = { ...data, tasks: nextTasks, counter, updatedAt: now, pendingGoogleDeletes: [] };
    await sb.from('taskdesk_state').update({ data: newData, updated_at: new Date(now).toISOString() }).eq('id', syncId);

    return new Response(JSON.stringify({ connected: true, taskCount: nextTasks.length }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
