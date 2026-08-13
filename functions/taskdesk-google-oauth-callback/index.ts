// Supabase Edge Function: taskdesk-google-oauth-callback
//
// Google redirects here after the user approves calendar access for
// タスクデスク. Unlike task-calendar's callback, there's no Supabase Auth
// session involved - taskdesk has no login. `state` instead carries
// taskdesk's own sync code (the same code shown in the app's rail / used
// to link devices), set by the client when it built the authorization URL.
//
// On first connect, finds-or-creates a dedicated "タスクデスク" calendar so
// 2-way sync has an unambiguous namespace: everything in that calendar is a
// taskdesk task, nothing else on the user's other calendars is touched.
//
// Deploy via the Supabase Dashboard (Edge Functions > Deploy a new function
// > Via Editor). Turn OFF "Enforce JWT Verification" for this function -
// Google's redirect here is a plain unauthenticated GET request.
// Reuses the same GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets already
// set up for task-calendar. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically.

import { createClient } from 'npm:@supabase/supabase-js@2';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const APP_URL = 'https://kojiroulab.github.io/kojiroulab-taskdesk/';
const CALENDAR_NAME = 'タスクデスク';

function redirectTo(status: 'connected' | 'error', detail?: string) {
  const url = new URL(APP_URL);
  url.searchParams.set('google', status);
  if (detail) url.searchParams.set('detail', detail);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function findOrCreateCalendar(accessToken: string): Promise<string> {
  const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (listRes.ok) {
    const list = await listRes.json();
    const existing = (list.items || []).find((c: any) => c.summary === CALENDAR_NAME);
    if (existing) return existing.id;
  }
  const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: CALENDAR_NAME }),
  });
  if (!createRes.ok) throw new Error('calendar create failed: ' + (await createRes.text()));
  const created = await createRes.json();
  return created.id;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const syncId = url.searchParams.get('state'); // taskdeskの同期コード
  const error = url.searchParams.get('error');

  if (error) return redirectTo('error', error);
  if (!code || !syncId) return redirectTo('error', 'missing_code_or_state');

  try {
    const redirectUri = `${SUPABASE_URL}/functions/v1/taskdesk-google-oauth-callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('token exchange failed', await tokenRes.text());
      return redirectTo('error', 'token_exchange_failed');
    }
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      // クライアント側で毎回 prompt=consent を付けているので通常は発生しないはずのガード
      return redirectTo('error', 'no_refresh_token');
    }

    const calendarId = await findOrCreateCalendar(tokens.access_token);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error: upsertErr } = await sb.from('taskdesk_google_accounts').upsert({
      id: syncId,
      refresh_token: tokens.refresh_token,
      calendar_id: calendarId,
      connected_at: new Date().toISOString(),
    });
    if (upsertErr) {
      console.error('upsert failed', upsertErr);
      return redirectTo('error', 'save_failed');
    }

    return redirectTo('connected');
  } catch (e) {
    console.error(e);
    return redirectTo('error', 'unexpected');
  }
});
