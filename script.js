const SUPA_URL = 'https://nsjncrhwhbtzndhrxavr.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zam5jcmh3aGJ0em5kaHJ4YXZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0Njg2NTksImV4cCI6MjA5NjA0NDY1OX0.arTqEq1L5jkiOI8X09DKXb2kaWsuFTrGZWm4QWxm0gM';

let supaSession = ld('uc_session_v1', null);

async function sb(method, table, opts={}, _isRetry) {
  const {eq, data, select, order, limit, upsert, onConflict, neq, in: inFilter} = opts;
  let url = `${SUPA_URL}/rest/v1/${table}`;
  const params = new URLSearchParams();
  if (select) params.set('select', select);
  if (order)  params.set('order', order);
  if (limit)  params.set('limit', String(limit));
  if (eq) Object.entries(eq).forEach(([k,v]) => params.set(k, 'eq.' + v));
  if (neq) Object.entries(neq).forEach(([k,v]) => params.set(k, 'neq.' + v));
  if (inFilter) Object.entries(inFilter).forEach(([k,vals]) => params.set(k, 'in.(' + (vals||[]).join(',') + ')'));
  if (upsert && onConflict) params.set('on_conflict', onConflict);
  if (params.toString()) url += '?' + params.toString();
  const authToken = (supaSession && supaSession.access_token) ? supaSession.access_token : SUPA_KEY;
  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + authToken,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? (upsert ? 'resolution=merge-duplicates,return=representation' : 'return=representation') :
              method === 'PATCH' ? 'return=representation' : ''
  };
  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined
  });
  if (!res.ok && res.status !== 204) {
    // An admin session token lasts ~1 hour. A live match (plus the rating
    // window after it) easily runs longer than that, so a signed-in admin's
    // token can quietly expire mid-match. Without this, every write after
    // that point (goals, cards, lineup changes) would fail with a 401 and
    // just get swallowed by a console.warn — invisible to the admin, who'd
    // reasonably assume everything was saving fine. So: on a 401, try
    // refreshing the session once and replaying the exact same request
    // before giving up.
    if (res.status === 401 && !_isRetry && supaSession && supaSession.refresh_token) {
      try {
        const refreshed = await supaAuthRefresh(supaSession.refresh_token);
        saveSession(refreshed);
        return await sb(method, table, opts, true);
      } catch(e) {
        clearSession();
        isAdmin=false;currentAdmin=null;
        if(typeof updAB==='function') updAB();
        throw new Error('Your admin session expired — please log in again to keep saving changes.');
      }
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${res.status} on ${table}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Proactively refresh a signed-in admin's session well before it expires,
// so a long live match never runs into the 401 case above in the first
// place. Runs quietly in the background; does nothing if not logged in.
setInterval(async function(){
  if(!supaSession || !supaSession.refresh_token) return;
  if(Date.now() < supaSession.expires_at - 5*60*1000) return; // more than 5 min left, nothing to do
  try{
    const refreshed = await supaAuthRefresh(supaSession.refresh_token);
    saveSession(refreshed);
  }catch(e){
    console.warn('Background session refresh failed:', e.message);
  }
}, 60000);

async function sbUpload(bucket, filePath, file) {
  const authToken = (supaSession && supaSession.access_token) ? supaSession.access_token : SUPA_KEY;
  const res = await fetch(`${SUPA_URL}/storage/v1/object/${bucket}/${filePath}`, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + authToken,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: file
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Upload failed (HTTP ${res.status})`);
  }
  return `${SUPA_URL}/storage/v1/object/public/${bucket}/${filePath}`;
}

// Shared helper: uploads an image file to Supabase Storage and returns its
// public URL, instead of embedding the full file as base64 text directly
// in a database row. Storing megabytes of base64 image data in every
// player/gallery/staff row is what was making the whole app slow to load
// under concurrent use — every page view had to pull all that embedded
// image data through the database itself instead of a lightweight URL
// that browsers can cache normally.
async function uploadImageToStorage(file, folder){
  const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop().replace(/[^a-zA-Z0-9]/g,'') : 'jpg';
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  return await sbUpload('media', path, file);
}

function usernameToEmail(username){
  const u = (username||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'');
  return u + '@ucsports.internal';
}
async function supaAuthSignIn(username, password){
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {'apikey': SUPA_KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify({email: usernameToEmail(username), password})
  });
  const json = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(json.error_description || json.msg || 'Invalid username or password.');
  return json; // {access_token, refresh_token, expires_in, user:{id,...}}
}
async function supaAuthSignUp(username, password){
  const res = await fetch(`${SUPA_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: {'apikey': SUPA_KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify({email: usernameToEmail(username), password})
  });
  const json = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(json.error_description || json.msg || json.error || 'Could not create account.');
  return json; // {access_token, refresh_token, user:{id,...}} (or just user if email confirmation is on)
}
async function supaAuthRefresh(refreshToken){
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {'apikey': SUPA_KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify({refresh_token: refreshToken})
  });
  const json = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(json.error_description || 'Session expired.');
  return json;
}
function saveSession(authResp){
  supaSession = {
    access_token: authResp.access_token,
    refresh_token: authResp.refresh_token,
    user_id: authResp.user?.id,
    expires_at: Date.now() + ((authResp.expires_in||3600)*1000)
  };
  sv('uc_session_v1', supaSession);
}
function clearSession(){
  supaSession = null;
  sv('uc_session_v1', null);
}

async function restoreSession(){
  if(!supaSession || !supaSession.refresh_token) return false;
  try{
    if(Date.now() >= supaSession.expires_at - 30000){
      const refreshed = await supaAuthRefresh(supaSession.refresh_token);
      saveSession(refreshed);
    }
    return true;
  }catch(e){
    clearSession();
    return false;
  }
}

async function loadClubsFromDB() {
  try {
    const rows = await sb('GET', 'clubs', {select: '*', order: 'sort_order'});
    clubs = (rows || []).map(r => ({
      ...r, id: r.id,
      primary: r.primary_color, accent: r.accent_color, highlight: r.highlight_color
    }));
    // Enforce Warriors → Gladiators → Titans order
    var _ORDER=['warriors','gladiators','titans'];
    clubs.sort(function(a,b){
      var ai=_ORDER.indexOf(a.id),bi=_ORDER.indexOf(b.id);
      return (ai<0?99:ai)-(bi<0?99:bi);
    });
    clubs.forEach(cl => { if (!clubData[cl.id]) clubData[cl.id] = {players:[], matchdays:[], headlines:[]}; });
    return true;
  } catch(e) { console.warn('DB load clubs failed:', e.message); return false; }
}

function normalizeMatchdayRow(m){
  return {
    ...m, id: m.id, _id: m.id,
    date: m.match_date, kickoffTime: m.kickoff_time,
    homeGoals: m.home_goals||0, awayGoals: m.away_goals||0,
    ratingWindowHrs: m.rating_window_hrs||24,
    ratingOpenOverride: m.rating_open_override,
    forceClose: m.force_close||false, forceOpen: m.force_open||false,
    durationKey: m.duration_key||'90',
    htPaused: m.ht_paused||false,
    htPauseStart: m.ht_pause_start||0,
    htPausedTotal: m.ht_paused_total||0,
    matchStartedAt: m.match_started_at||0,
    currentHalf: m.current_half||1,
    halfStartedAt: m.half_started_at||0
  };
}
async function loadClubDataFromDB(cid) {
  try {
    const [players, matchdays, headlines] = await Promise.all([
      sb('GET', 'players', {eq: {club_id: cid}, select: '*', order: 'created_at'}),
      sb('GET', 'matchdays', {eq: {club_id: cid}, select: '*', order: 'created_at'}),
      sb('GET', 'headlines', {eq: {club_id: cid}, select: '*', order: 'created_at.desc'})
    ]);
    const normPlayers = (players||[]).map(p => ({
      ...p, id: p.id, _id: p.id,
      yellowCards: p.yellow_cards||0,
      redCards: p.red_cards||0,
      cleanSheets: p.clean_sheets||0,
      attempts: p.attempts||0,
      intercepts: p.intercepts||0,
      goalsConceded: p.goals_conceded||0,
      saves: p.saves||0
    }));
    const normMds = (matchdays||[]).map(normalizeMatchdayRow);
    clubData[cid] = {players: normPlayers, matchdays: normMds, headlines: headlines||[]};
    sv('uc_data_v7', clubData);
    await Promise.all([loadAllRatingsFromDB(cid), loadClubDescFromDB(cid), loadTechTeamFromDB(cid), loadAllLineupsFromDB(cid)]);
  } catch(e) { console.warn('DB load club data failed:', e.message); }
}

async function loadClubMatchdaysFromDB(cid) {
  try {
    const [matchdays, headlines] = await Promise.all([
      sb('GET', 'matchdays', {eq: {club_id: cid}, select: '*', order: 'created_at'}),
      sb('GET', 'headlines', {eq: {club_id: cid}, select: '*', order: 'created_at.desc'})
    ]);
    const normMds = (matchdays||[]).map(normalizeMatchdayRow);
    const existing = clubData[cid] || {players:[], matchdays:[], headlines:[]};
    clubData[cid] = {players: existing.players||[], matchdays: normMds, headlines: headlines||[]};
  } catch(e) { console.warn('DB load club matchdays failed:', e.message); }
}

async function loadMatchdayDataFromDB(cid, mid) {
  try {
    const [scRows, luRows, ratingRows, cmtRows] = await Promise.all([
      sb('GET', 'scorers', {eq: {matchday_id: mid}, select: '*'}),
      sb('GET', 'lineups', {eq: {matchday_id: mid}, select: '*'}),
      sb('GET', 'ratings', {eq: {matchday_id: mid}, select: '*'}),
      sb('GET', 'comments', {eq: {matchday_id: mid}, select: '*', order: 'created_at'})
    ]);
    const sc = scRows&&scRows.length ? scRows[0] : {goals:[], assists:[], cards:[]};
    scorers[cid+'_'+mid] = {goals: sc.goals||[], assists: sc.assists||[], cards: sc.cards||[]};
    const lu = luRows&&luRows.length ? luRows[0] : {formation:'', slots:{}, subs:[]};
    lineups[cid+'_'+mid] = {formation: lu.formation||'', slots: lu.slots||{}, subs: lu.subs||[]};
    (ratingRows||[]).forEach(r => {
      const k = cid+'_'+mid+'_'+r.player_id;
      if (!ratings[k]) ratings[k] = {};
      ratings[k][r.fan_id] = {stars: r.stars};
      const ok = cid+'_'+r.player_id;
      if (!ratings[ok]) ratings[ok] = {};
      ratings[ok][r.fan_id+'_'+mid] = {stars: r.stars};
    });
    (cmtRows||[]).forEach(cm => {
      const key = cid+'_'+mid+'_'+cm.player_id;
      if (!comments[key]) comments[key] = [];
      if (!comments[key].find(x => x.id === cm.id))
        comments[key].push({id: cm.id, fanId: cm.fan_id, text: cm.text, ts: new Date(cm.created_at).toLocaleString()});
    });
  } catch(e) { console.warn('DB load matchday data failed:', e.message); }
}

async function loadGalleryFromDB() {
  try {
    const rows = await sb('GET', 'gallery', {select: '*', order: 'created_at.desc'});
    gallery = (rows||[]).map(r => ({...r, clubId: r.club_id||null}));
    sv('uc_gallery_v7', gallery);
    return true;
  } catch(e) {
    // Fall back to localStorage if table doesn't exist yet
    gallery = ld('uc_gallery_v7', []);
    return false;
  }
}

async function loadAdminsFromDB() {
  // Deprecated: admin accounts now live in Supabase Auth + admin_profiles.
  // Kept as a no-op only in case anything still references the name.
  return true;
}

function sortStandingsRows(rows, isNB){
  rows.sort(function(a,b){
    const pa=isNB?(a.w||0)*2+(a.d||0):(a.w||0)*3+(a.d||0);
    const pb=isNB?(b.w||0)*2+(b.d||0):(b.w||0)*3+(b.d||0);
    if(pb!==pa) return pb-pa;
    const gda=(a.gf||0)-(a.ga||0), gdb=(b.gf||0)-(b.ga||0);
    if(gdb!==gda) return gdb-gda;
    return (b.gf||0)-(a.gf||0);
  });
  return rows;
}
async function loadStandingsFromDB(cid) {
  try {
    const rows = await sb('GET', 'standings', {eq: {club_id: cid}, select: '*', order: 'created_at'});
    if (!standings[cid]) standings[cid] = [];
    standings[cid] = (rows||[]).map(r => ({...r, id: r.id}));
    sortStandingsRows(standings[cid], isNetball(cid));
    return true;
  } catch(e) {
    console.warn('Could not load standings:', e.message);
    return false;
  }
}

async function loadLiveScorersGlobal() {
  if (!dbConnected) return;
  const liveMids = [];
  clubs.forEach(c => {
    (getData(c.id)?.matchdays||[]).forEach(m => { if (m.status === 'live') liveMids.push(m.id); });
  });
  if (!liveMids.length) return;
  try {
    const rows = await sb('GET', 'scorers', {in: {matchday_id: liveMids}, select: '*'});
    (rows||[]).forEach(r => {
      scorers[r.club_id + '_' + r.matchday_id] = {goals: r.goals||[], assists: r.assists||[], cards: r.cards||[]};
    });
    sv('uc_scorers_v7', scorers);
  } catch(e) { console.warn('loadLiveScorersGlobal failed:', e.message); }
}

// DB write helpers
async function dbSaveClub(cid, update) {
  try {
    const dbUpdate = {
      name: update.name, short: update.short, tagline: update.tagline,
      primary_color: update.primary, accent_color: update.accent,
      highlight_color: update.highlight, logo: update.logo
    };
    await sb('PATCH', 'clubs', {eq: {id: cid}, data: dbUpdate});
  } catch(e) { console.warn('dbSaveClub failed:', e.message); }
}

async function dbSavePlayer(pid, update) {
  try {
    const dbUpdate = {
      name: update.name, num: update.num, pos: update.pos,
      goals: update.goals||0, assists: update.assists||0, gp: update.gp||0,
      img: update.img, age: update.age||0, nationality: update.nationality||'',
      hometown: update.hometown||'', height: update.height||0,
      foot: update.foot||'', shirtname: update.shirtname||'', bio: update.bio||'',
      yellow_cards: update.yellowCards||0, red_cards: update.redCards||0,
      clean_sheets: update.cleanSheets||0, attempts: update.attempts||0,
      intercepts: update.intercepts||0,
      goals_conceded: update.goalsConceded||0, saves: update.saves||0
    };
    const result = await sb('PATCH', 'players', {eq: {id: pid}, data: dbUpdate});
    if(!result || result.length === 0){
      showToast('DB Warning', 'Player update did not match any row in Supabase (id: '+pid+')');
      console.error('dbSavePlayer: no rows updated for id', pid, result);
    }
    return result;
  } catch(e) {
    console.error('dbSavePlayer failed:', e.message);
    showToast('DB Error', 'Could not save to database: '+e.message);
    throw e;
  }
}

async function dbAddPlayer(cid, p) {
  try {
    const rows = await sb('POST', 'players', {data: {
      club_id: cid, name: p.name, num: p.num, pos: p.pos,
      goals: 0, assists: 0, gp: 0
    }});
    return Array.isArray(rows) ? rows[0] : rows;
  } catch(e) { console.warn('dbAddPlayer failed:', e.message); return null; }
}

async function dbDeletePlayer(pid) {
  try { await sb('DELETE', 'players', {eq: {id: pid}}); } catch(e) { console.warn(e.message); }
}

async function dbDeleteRatingsForMatchday(mid) {
  try { await sb('DELETE', 'ratings', {eq: {matchday_id: mid}}); }
  catch(e) { console.warn('dbDeleteRatingsForMatchday failed:', e.message); }
}
async function dbDeleteRatingsForPlayerInMatchday(mid, pid) {
  try { await sb('DELETE', 'ratings', {eq: {matchday_id: mid, player_id: pid}}); }
  catch(e) { console.warn('dbDeleteRatingsForPlayerInMatchday failed:', e.message); }
}
async function dbDeleteAllRatingsForClub(cid) {
  try { await sb('DELETE', 'ratings', {eq: {club_id: cid}}); }
  catch(e) { console.warn('dbDeleteAllRatingsForClub failed:', e.message); }
}
async function dbDeleteCommentsForMatchday(mid) {
  try { await sb('DELETE', 'comments', {eq: {matchday_id: mid}}); }
  catch(e) { console.warn('dbDeleteCommentsForMatchday failed:', e.message); }
}
async function dbDeleteScorersForMatchday(mid) {
  try { await sb('DELETE', 'scorers', {eq: {matchday_id: mid}}); }
  catch(e) { console.warn('dbDeleteScorersForMatchday failed:', e.message); }
}
async function dbDeleteLineupForMatchday(mid) {
  try { await sb('DELETE', 'lineups', {eq: {matchday_id: mid}}); }
  catch(e) { console.warn('dbDeleteLineupForMatchday failed:', e.message); }
}
async function dbDeleteGalleryItemRow(id) {
  try { await sb('DELETE', 'gallery', {eq: {id: id}}); }
  catch(e) { console.warn('dbDeleteGalleryItemRow failed:', e.message); }
}

async function dbSaveMatchday(cid, md) {
  try {
    const data = {
      club_id: cid, label: md.label, opponent: md.opponent,
      venue: md.venue||'', match_date: md.date||'', kickoff_time: md.kickoffTime||'',
      status: md.status||'upcoming', result: md.result||'',
      home_goals: md.homeGoals||0, away_goals: md.awayGoals||0,
      rating_window_hrs: md.ratingWindowHrs||24,
      rating_open_override: md.ratingOpenOverride||null,
      force_close: md.forceClose||false, force_open: md.forceOpen||false, duration_key: md.durationKey||'90',
      ht_paused: md.htPaused||false, ht_pause_start: md.htPauseStart||null, ht_paused_total: md.htPausedTotal||0,
      match_started_at: md.matchStartedAt||null, current_half: md.currentHalf||1,
      half_started_at: md.halfStartedAt||null
    };
    if (md._dbId) {
      await sb('PATCH', 'matchdays', {eq: {id: md._dbId}, data});
      return true;
    } else {
      const rows = await sb('POST', 'matchdays', {data});
      const row = Array.isArray(rows) ? rows[0] : rows;
      md._dbId = row?.id;
      return row || true;
    }
  } catch(e) { console.warn('dbSaveMatchday failed:', e.message); return false; }
}

async function dbDeleteMatchday(dbId) {
  try { await sb('DELETE', 'matchdays', {eq: {id: dbId}}); } catch(e) { console.warn(e.message); }
}

async function dbSaveScorers(cid, mid, sc) {
  const existing = await sb('GET', 'scorers', {eq: {matchday_id: mid}, select: 'id'});
  const payload = {goals: sc.goals||[], assists: sc.assists||[], cards: sc.cards||[]};
  if (existing && existing.length) {
    await sb('PATCH', 'scorers', {eq: {matchday_id: mid}, data: payload});
  } else {
    await sb('POST', 'scorers', {data: {club_id: cid, matchday_id: mid, ...payload}});
  }
}

async function dbSaveLineup(cid, mid, lu) {
  const existing = await sb('GET', 'lineups', {eq: {matchday_id: mid}, select: 'id'});
  const data = {club_id: cid, matchday_id: mid, formation: lu.formation, slots: lu.slots, subs: lu.subs};
  if (existing && existing.length) {
    await sb('PATCH', 'lineups', {eq: {matchday_id: mid}, data});
  } else {
    await sb('POST', 'lineups', {data});
  }
}

async function dbPostRating(cid, mid, pid, stars) {
  await sb('POST', 'ratings', {
    data: {club_id: cid, matchday_id: mid, player_id: pid, fan_id: fanId, stars},
    upsert: true,
    onConflict: 'club_id,matchday_id,player_id,fan_id'
  });
}
async function loadAllRatingsFromDB(cid) {
  try {
    const rows = await sb('GET', 'ratings', {eq: {club_id: cid}, select: '*'});
    (rows||[]).forEach(r => {
      const k = cid+'_'+r.matchday_id+'_'+r.player_id;
      if (!ratings[k]) ratings[k] = {};
      ratings[k][r.fan_id] = {stars: r.stars};
      const ok = cid+'_'+r.player_id;
      if (!ratings[ok]) ratings[ok] = {};
      ratings[ok][r.fan_id+'_'+r.matchday_id] = {stars: r.stars};
    });
    sv('uc_ratings_v7', ratings);
  } catch(e) { console.warn('loadAllRatingsFromDB failed:', e.message); }
}

// Bulk-loads every lineup for a club (not just whichever single matchday
// happens to be open) so appearance counts ("played in N matches") can be
// computed accurately from the player's very first matchday onward,
// instead of only reflecting whichever matchdays this browser session
// happened to visit.
async function loadAllLineupsFromDB(cid) {
  try {
    const rows = await sb('GET', 'lineups', {eq: {club_id: cid}, select: '*'});
    (rows||[]).forEach(lu => {
      lineups[cid+'_'+lu.matchday_id] = {formation: lu.formation||'', slots: lu.slots||{}, subs: lu.subs||[]};
    });
    sv('uc_lineups_v7', lineups);
  } catch(e) { console.warn('loadAllLineupsFromDB failed:', e.message); }
}

// Counts how many matchdays a player has actually appeared in for a club —
// started (in the lineup slots) or came on as a substitute — by scanning
// every loaded lineup, rather than relying on a manually-incremented
// counter that could drift or double-count when a lineup gets edited.
function getPlayerAppearances(cid, pid){
  let count=0;
  Object.keys(lineups).forEach(k=>{
    if(k.indexOf(cid+'_')!==0) return;
    const lu=lineups[k];if(!lu) return;
    const started=Object.values(lu.slots||{}).includes(pid);
    const subbedOn=(lu.subs||[]).some(s=>s.in===pid);
    if(started||subbedOn) count++;
  });
  return count;
}

async function dbPostComment(cid, mid, pid, text) {
  try {
    const rows = await sb('POST', 'comments', {data: {club_id: cid, matchday_id: mid, player_id: pid, fan_id: fanId, text}});
    return Array.isArray(rows) ? rows[0] : rows;
  } catch(e) { console.warn('dbPostComment failed:', e.message); return null; }
}

async function dbDeleteComment(id) {
  try { await sb('DELETE', 'comments', {eq: {id}}); } catch(e) { console.warn(e.message); }
}

async function dbWriteLog(action, category, details) {
  try {
    await sb('POST', 'logs', {data: {
      action, category,
      club_id: details.club_id||null,
      matchday_id: details.matchday_id||null,
      player_id: details.player_id||null,
      fan_id: fanId, details
    }});
  } catch(e) { /* silent */ }
}

async function dbSaveHeadline(cid, title, date, body) {
  try {
    const rows = await sb('POST', 'headlines', {data: {club_id: cid, title, date, body: body||''}});
    return Array.isArray(rows) ? rows[0] : rows;
  } catch(e) { console.warn('dbSaveHeadline failed:', e.message); return null; }
}
async function dbUpdateHeadline(id, title, date, body) {
  try {
    await sb('PATCH', 'headlines', {eq: {id}, data: {title, date, body: body||''}});
    return true;
  } catch(e) { console.warn('dbUpdateHeadline failed:', e.message); return false; }
}

async function dbDeleteHeadline(id) {
  try { await sb('DELETE', 'headlines', {eq: {id}}); } catch(e) { console.warn(e.message); }
}

async function dbSaveStandingRow(cid, row) {
  try {
    const existing = await sb('GET', 'standings', {eq: {club_id: cid, team: row.team}, select: 'id'});
    if (existing && existing.length) {
      await sb('PATCH', 'standings', {eq: {id: existing[0].id}, data: {...row, club_id: cid}});
    } else {
      await sb('POST', 'standings', {data: {...row, club_id: cid}});
    }
  } catch(e) { console.warn('dbSaveStandingRow failed:', e.message); }
}

async function dbClearStandings(cid) {
  try {
    const rows = await sb('GET', 'standings', {eq: {club_id: cid}, select: 'id'});
    for (const r of (rows||[])) { await sb('DELETE', 'standings', {eq: {id: r.id}}); }
  } catch(e) { console.warn('dbClearStandings failed:', e.message); }
}
async function dbDeleteStandingRow(cid, team) {
  try {
    const rows = await sb('GET', 'standings', {eq: {club_id: cid, team}, select: 'id'});
    for (const r of (rows||[])) { await sb('DELETE', 'standings', {eq: {id: r.id}}); }
  } catch(e) { console.warn('dbDeleteStandingRow failed:', e.message); }
}

async function dbSaveGalleryItem(item) {
  try {
    const rows = await sb('POST', 'gallery', {data: {
      title: item.title, date: item.date,
      club_id: item.clubId||null, img: item.img
    }});
    return Array.isArray(rows) ? rows[0] : rows;
  } catch(e) { console.warn('dbSaveGalleryItem failed, saving locally:', e.message); return null; }
}

async function dbDeleteGalleryItem(id) {
  try { await sb('DELETE', 'gallery', {eq: {id}}); } catch(e) { console.warn(e.message); }
}

// Real admin login: verifies the password via Supabase Auth (hashed,
// server-side — never compared in this file), then looks up that
// admin's profile (name/role/managed club).
async function dbLoginAdmin(username, password) {
  const authResp = await supaAuthSignIn(username, password); // throws on bad credentials
  saveSession(authResp);
  try {
    const rows = await sb('GET', 'admin_profiles', {eq: {user_id: authResp.user.id}, select: '*'});
    if (!rows || !rows.length) { clearSession(); throw new Error('No admin profile found for this account.'); }
    return rows[0];
  } catch(e) { clearSession(); throw e; }
}

async function dbCreateAdmin(admin) {
  const signupResp = await supaAuthSignUp(admin.username, admin.password); // throws on failure
  const newUserId = signupResp.user && signupResp.user.id;
  if (!newUserId) throw new Error('Account created but no user id returned — check if email confirmation is required in Supabase Auth settings.');
  await sb('POST', 'admin_profiles', {data: {
    user_id: newUserId, username: admin.username,
    name: admin.name, role: admin.role, managed_club: admin.managedClub
  }});
  return true;
}

async function dbDeleteAdmin(userId) {
  await sb('DELETE', 'admin_profiles', {eq: {user_id: userId}});
}

async function dbGetAdmins() {
  try {
    return await sb('GET', 'admin_profiles', {select: 'user_id,username,name,role,managed_club,created_at', order: 'created_at'}) || [];
  } catch(e) { return []; }
}

let dbConnected = false;
async function checkDBConnection() {

  try {
    await sb('GET', 'clubs', {select: 'id', limit: 1});
    dbConnected = true;
  } catch(e) {
    dbConnected = false;
    console.warn('Supabase not available, using localStorage');
  }
}


let supaRT=null;
const RT_TABLES=['matchdays','scorers','clubs','players','gallery','headlines','comments','ratings','standings','admin_profiles','settings'];
function initRealtime(){
  if(!dbConnected)return;
  if(!window.supabase||typeof window.supabase.createClient!=='function'){
    console.warn('Supabase realtime client (supabase-js) not loaded — live sync disabled.');
    return;
  }
  try{
    supaRT=window.supabase.createClient(SUPA_URL,SUPA_KEY);
    const ch=supaRT.channel('uc-realtime-all');
    RT_TABLES.forEach(function(tbl){
      ch.on('postgres_changes',{event:'*',schema:'public',table:tbl},function(payload){ handleRealtimeChange(tbl,payload); });
    });
    ch.subscribe(function(status){
      if(status==='SUBSCRIBED')console.log('Realtime sync connected');
      else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')console.warn('Realtime sync issue:',status);
    });
  }catch(e){ console.warn('Realtime init failed:', e.message); }
}
// Small debounce so a burst of changes (e.g. several quick goals) doesn't
// hammer the DB with duplicate refetches.
const rtDebounceTimers={};
function debounceRT(key,fn,wait){
  if(rtDebounceTimers[key])clearTimeout(rtDebounceTimers[key]);
  rtDebounceTimers[key]=setTimeout(fn,wait||250);
}
function refreshAfterRT(){
  const activeView=document.querySelector('.view.active');
  if(!activeView)return;
  if(activeView.id==='view-home')renderHome();
  else if(activeView.id==='view-club'&&clubId)renderClub();
  else if(activeView.id==='view-matchday'&&clubId&&mdId)renderMd();
  else if(activeView.id==='view-logshub')renderLogsHubTab(logsHubTab);
}
async function handleRealtimeChange(table,payload){
  const row=payload.new||payload.old||{};
  if(table==='matchdays'){
    const cid=row.club_id;if(!cid)return;
    const wentLive=payload.eventType==='UPDATE'&&payload.old&&payload.old.status!=='live'&&row.status==='live';
    if(wentLive){
      const club=getClub(cid);
      const k=cid+'_'+row.id+'_live';
      if(!notifSent[k]){notifSent[k]=true;sv('uc_notifs_v7',notifSent);sendNotif('Match is LIVE',`${club?club.short:'A team'} vs ${row.opponent||''} - rate now!`);}
    }
    // Apply the change straight from the pushed row instead of asking the
    // server for the whole club's data again — every viewer re-fetching
    // players/matchdays/headlines/ratings on every score update is what
    // was bogging things down when lots of people were watching a live
    // match at once. The realtime payload already has everything we need.
    if(clubData[cid]){
      const mds=clubData[cid].matchdays||(clubData[cid].matchdays=[]);
      const idx=mds.findIndex(m=>m.id===row.id);
      if(payload.eventType==='DELETE'){
        if(idx>=0) mds.splice(idx,1);
      } else {
        const normalized=normalizeMatchdayRow(row);
        if(idx>=0) mds[idx]=normalized; else mds.push(normalized);
      }
      sv('uc_data_v7',clubData);
    }
    debounceRT('md_'+cid,async function(){
      await loadLiveScorersGlobal();
      checkScheduledNotifs();
      if(clubId===cid&&mdId===row.id){
        const fresh=getData(cid)?.matchdays?.find(m=>m.id===row.id);
        if(fresh){ if(fresh.status==='live') startTimer(fresh); else stopTimer(); }
      }
      refreshAfterRT();
    },400);
  } else if(table==='scorers'){
    const mid=row.matchday_id;if(!mid)return;
    if(payload.eventType!=='DELETE'&&row.club_id){
      scorers[row.club_id+'_'+mid]={goals:row.goals||[],assists:row.assists||[],cards:row.cards||[]};
      sv('uc_scorers_v7',scorers);
    }
    debounceRT('sc_'+mid,refreshAfterRT,150);
  } else if(table==='clubs'){
    debounceRT('clubs',async function(){ await loadClubsFromDB(); refreshAfterRT(); });
  } else if(table==='players'){
    const cid=row.club_id;if(!cid)return;
    debounceRT('players_'+cid,async function(){ await loadClubDataFromDB(cid); refreshAfterRT(); });
  } else if(table==='gallery'){
    debounceRT('gallery',async function(){ await loadGalleryFromDB(); refreshAfterRT(); });
  } else if(table==='headlines'){
    const cid=row.club_id;if(!cid)return;
    debounceRT('headlines_'+cid,async function(){ await loadClubDataFromDB(cid); refreshAfterRT(); });
  } else if(table==='comments'||table==='ratings'){
    const mid=row.matchday_id,cid=row.club_id;
    if(mid&&clubId&&mdId===mid){
      debounceRT(table+'_'+mid,async function(){ await loadMatchdayDataFromDB(clubId,mdId); refreshAfterRT(); });
    }
    if(table==='ratings'&&cid){
      debounceRT('ratings_all_'+cid,async function(){
        await loadAllRatingsFromDB(cid);
        const lbView=document.getElementById('view-leaderboard');
        if(lbView&&lbView.classList.contains('active')) renderLeaderboardHub(lbHubTab||'all');
      },400);
    }
  } else if(table==='standings'){
    const cid=row.club_id;if(!cid)return;
    debounceRT('standings_'+cid,async function(){
      await loadStandingsFromDB(cid);
      if($('m-standings')?.classList.contains('open')&&$('standings-club-id')?.value===cid) renderStandingsModal(cid);
      refreshAfterRT();
    });
  } else if(table==='admin_profiles'){
    debounceRT('admin_profiles',function(){ if($('m-create-admin')&&$('m-create-admin').classList.contains('open')) renderAdminProfiles(); });
  } else if(table==='settings'){
    if(row.key==='uc_logo'){
      ucLogo=row.value||null;
      if(ucLogo)localStorage.setItem('uc_main_logo',ucLogo);else localStorage.removeItem('uc_main_logo');
      renderBrandLogo();
      refreshAfterRT();
    } else if(row.key&&row.key.indexOf('club_desc_')===0){
      const cid=row.key.slice('club_desc_'.length);
      clubDescriptions[cid]=row.value||'';sv('uc_clubdesc_v7',clubDescriptions);
      if(clubId===cid) refreshAfterRT();
    } else if(row.key&&row.key.indexOf('techteam_')===0){
      const cid=row.key.slice('techteam_'.length);
      try{ techTeams[cid]=JSON.parse(row.value)||[]; }catch(e){ techTeams[cid]=[]; }
      sv('uc_techteam_v7',techTeams);
      if(clubId===cid) refreshAfterRT();
    }
  }
}

const MAX_ADMINS = 8;

const POSITIONS = {
  Football:['Goalkeeper','Right Back','Centre Back','Left Back','Defensive Mid',
            'Central Mid','Right Mid','Left Mid','Attacking Mid','Right Wing','Left Wing',
            'Striker','Forward'],
  Netball: ['Goal Shooter','Goal Attack','Wing Attack','Centre',
            'Wing Defence','Goal Defence','Goal Keeper']
};

const FORMATIONS = {
  Football:{
    '4-3-3':  [['GK'],['LB','CB','CB','RB'],['LCM','CM','RCM'],['LW','ST','RW']],
    '4-4-2':  [['GK'],['LB','CB','CB','RB'],['LM','LCM','RCM','RM'],['ST','ST']],
    '4-2-3-1':[['GK'],['LB','CB','CB','RB'],['LDM','RDM'],['LW','CAM','RW'],['ST']],
    '4-3-2-1':[['GK'],['LB','CB','CB','RB'],['LCM','CM','RCM'],['LW','RW'],['ST']],
    '3-5-2':  [['GK'],['LCB','CB','RCB'],['LWB','LCM','CM','RCM','RWB'],['ST','ST']],
    '3-4-3':  [['GK'],['LCB','CB','RCB'],['LM','LCM','RCM','RM'],['LW','ST','RW']],
    '5-3-2':  [['GK'],['LWB','LCB','CB','RCB','RWB'],['LCM','CM','RCM'],['ST','ST']],
    '4-5-1':  [['GK'],['LB','CB','CB','RB'],['LM','LCM','CM','RCM','RM'],['ST']],
    '4-1-4-1':[['GK'],['LB','CB','CB','RB'],['CDM'],['LM','LCM','RCM','RM'],['ST']],
  },
  Netball:{'7-standard':[['GK'],['GD'],['WD'],['C'],['WA'],['GA'],['GS']]}
};

const DURATION_MAP = {
  '90':   {mins:90, halves:2, halfMins:45, sport:'Football', label:'2x45 min'},
  '80':   {mins:80, halves:2, halfMins:40, sport:'Football', label:'2x40 min'},
  '70':   {mins:70, halves:2, halfMins:35, sport:'Football', label:'2x35 min'},
  '60':   {mins:60, halves:2, halfMins:30, sport:'Football', label:'2x30 min'},
  '60nb': {mins:60, halves:4, halfMins:15, sport:'Netball',  label:'4x15 min'},
  '48':   {mins:48, halves:4, halfMins:12, sport:'Netball',  label:'4x12 min'},
  '40nb': {mins:40, halves:4, halfMins:10, sport:'Netball',  label:'4x10 min'},
};

const RATING_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEF_LOGOS = {
  warriors:   "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='48' fill='%231d2d5a' stroke='%234dc8c8' stroke-width='3'/%3E%3Ctext x='50' y='58' text-anchor='middle' font-size='28' font-weight='900' fill='%234dc8c8' font-family='Georgia'%3EW%3C/text%3E%3C/svg%3E",
  gladiators: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='48' fill='%231d2d5a' stroke='%23d4407a' stroke-width='3'/%3E%3Ctext x='50' y='58' text-anchor='middle' font-size='28' font-weight='900' fill='%23d4407a' font-family='Georgia'%3EG%3C/text%3E%3C/svg%3E",
  titans:     "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='48' fill='%230d0d14' stroke='%23e8457a' stroke-width='3'/%3E%3Ctext x='50' y='58' text-anchor='middle' font-size='28' font-weight='900' fill='%23e8457a' font-family='Georgia'%3ET%3C/text%3E%3C/svg%3E"
};

const SEED_CLUBS = [
  {id:'warriors',  name:'Urban Circle Warriors FC',short:'Warriors FC', sport:'Football',primary:'#1d2d5a',accent:'#4dc8c8',highlight:'#e8457a',tagline:'Conquer Every Circle',logo:null},
  {id:'gladiators',name:'Urban Circle Gladiators', short:'Gladiators',  sport:'Football',primary:'#1d2d5a',accent:'#d4407a',highlight:'#ffffff',tagline:'Student Accommodation - Doornfontein',logo:null},
  {id:'titans',    name:'UC Titans Netball',        short:'UC Titans NC',sport:'Netball', primary:'#0d0d14',accent:'#e8457a',highlight:'#3d7dd4',tagline:'Rise Above All',logo:null}
];

const SEED_DATA = {
  warriors:{headlines:[{id:1,title:'Urban Circle Warriors FC kick off 2026 UJCFL Promotional League campaign',date:'2026-05-01'},{id:2,title:'Head Coach Masilo Solomon Maila names strong squad',date:'2026-04-28'}],matchdays:[],players:[
    {id:'p1', name:'Mfundiso Malinga',      pos:'Goalkeeper',    num:1, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p2', name:'Odirile Letsoalo',      pos:'Right Back',    num:2, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p3', name:'Samkelo Mdladla',       pos:'Centre Back',   num:3, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p4', name:'Sizwe Mnguni',          pos:'Centre Back',   num:4, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p5', name:'Thabo Hlalele',         pos:'Left Back',     num:5, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p6', name:'Thuto Magagane',        pos:'Central Mid',   num:6, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p7', name:'Noko Kgakoa',           pos:'Central Mid',   num:7, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p8', name:'Luxolo Zulu',           pos:'Central Mid',   num:8, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p9', name:'Bonginkosi Khawula',    pos:'Right Wing',    num:9, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p10',name:'Bandile Vilakazi',      pos:'Striker',       num:10,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p11',name:'Akhanani Mzileni',      pos:'Left Wing',     num:11,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p12',name:'Ayanda Makhathini',     pos:'Centre Back',   num:12,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p13',name:'Mduduzi Ngayo',         pos:'Central Mid',   num:13,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p14',name:'Amile Xulu',            pos:'Defensive Mid', num:14,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p15',name:'Tumelo Phakathi',       pos:'Striker',       num:15,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p16',name:'Bonginkosi Thabana',    pos:'Right Back',    num:16,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p17',name:'Nhlakanipho Phewa',     pos:'Right Wing',    num:17,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p18',name:'Siyabonga Khalishwayo', pos:'Central Mid',   num:18,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p19',name:'Koketso Ntoi',          pos:'Attacking Mid', num:19,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p20',name:'Simcelile Chule',       pos:'Forward',       num:20,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p21',name:'Kwande Thusi',          pos:'Striker',       num:21,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p22',name:'Asanda Gumede',         pos:'Left Wing',     num:22,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p23',name:'Andile Khoza',          pos:'Centre Back',   num:23,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p24',name:'Phakamani Langa',       pos:'Central Mid',   num:24,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p25',name:'Samkelo Cele',          pos:'Striker',       num:25,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''}
  ]},
  gladiators:{headlines:[{id:1,title:'UC Gladiators DC ready for 2024 UJCFL Promotional League',date:'2024-03-01'},{id:2,title:'Coach Tumelo Phakathi sets sights on promotion',date:'2024-02-20'}],matchdays:[],players:[
    {id:'p1', name:'Aluvuyo Dlabathi',            pos:'Goalkeeper',    num:1, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p2', name:'Sakhile Gumbi',               pos:'Right Back',    num:2, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p3', name:'Samkelo Mshengu',             pos:'Centre Back',   num:3, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p4', name:'Glan Ndhlovu',                pos:'Centre Back',   num:4, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p5', name:'Gcobani Mantlane',            pos:'Left Back',     num:5, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p6', name:'Nhlakanipho Shibe',           pos:'Central Mid',   num:6, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p7', name:'Perente Pusius Thulare',      pos:'Central Mid',   num:7, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p8', name:'Shelton Jason Shabangu',      pos:'Central Mid',   num:8, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p9', name:'Siyabonga Future Mncube',     pos:'Right Wing',    num:9, goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p10',name:'Kamogelo Makola',             pos:'Striker',       num:10,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p11',name:'Silas Phalane',               pos:'Left Wing',     num:11,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p12',name:'Aviwe France',                pos:'Central Mid',   num:12,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p13',name:'Boithatelo Samuel Tshabalala',pos:'Attacking Mid', num:13,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p14',name:'Tshepego Makwela',            pos:'Centre Back',   num:14,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p15',name:'Sanele Komani',               pos:'Striker',       num:15,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p16',name:'Buhle Phungula',              pos:'Defensive Mid', num:16,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p17',name:'Mncedisi Khoza',              pos:'Right Wing',    num:17,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p18',name:'Asanda Gift Xulu',            pos:'Central Mid',   num:18,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p19',name:'Thandanani Feni',             pos:'Left Mid',      num:19,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p20',name:'Innocent Nkosi',              pos:'Forward',       num:20,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p21',name:'Kamvelihle Jiba',             pos:'Striker',       num:21,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p22',name:'Cry Tlhako',                  pos:'Left Wing',     num:22,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p23',name:'Ntokozo Sangweni',            pos:'Attacking Mid', num:23,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p24',name:'Siyathokoza Myeni',           pos:'Right Back',    num:24,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p25',name:'Azola Mfenqa',                pos:'Centre Back',   num:25,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p26',name:'Melokuhle Malembe',           pos:'Central Mid',   num:26,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p27',name:'Lusanda Ntuli',               pos:'Central Mid',   num:27,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p28',name:'Zuko Molefe',                 pos:'Forward',       num:28,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p29',name:'Pontsho More',                pos:'Striker',       num:29,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p30',name:'Junior Ndlovu',               pos:'Striker',       num:30,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''}
  ]},
  titans:{headlines:[{id:1,title:'UC Titans NC ready to dominate 2026 UJ Campus Netball League',date:'2026-05-01'},{id:2,title:'Coach Siphesihle Hlatshwayo names 21-player squad',date:'2026-04-25'}],matchdays:[],players:[
    {id:'p1', name:'Gongota Hluma',                pos:'Goal Shooter', num:1, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p2', name:'Mfingwana Lumka',              pos:'Goal Attack',  num:2, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p3', name:'Pebane Ntokozo',               pos:'Wing Attack',  num:3, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p4', name:'Mochela Atlehang',             pos:'Centre',       num:4, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p5', name:'Sarah Bakare',                 pos:'Wing Defence', num:5, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p6', name:'Valencia Mahlangu',            pos:'Goal Defence', num:6, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p7', name:'Takalani Singo',               pos:'Goal Keeper',  num:7, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p8', name:'Lwando Noqhamza',              pos:'Wing Attack',  num:8, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p9', name:'Imange Mboniso',               pos:'Centre',       num:9, goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p10',name:'Keneilwe Leboho',              pos:'Goal Attack',  num:10,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p11',name:'Siphesihle Hlatshwayo',        pos:'Goal Shooter', num:11,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p12',name:'Dineo Moeketsi',               pos:'Wing Defence', num:12,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p13',name:'Misokuhle Mpume Ntshakala',    pos:'Goal Defence', num:13,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p14',name:'Olwethu Siyanda Mgcotyelwa',   pos:'Centre',       num:14,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p15',name:'Tiyiselani Ndobe',             pos:'Wing Attack',  num:15,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p16',name:'Nomfusi Tshekimfe',            pos:'Goal Defence', num:16,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p17',name:'Khomotso Makgabo Mabitsela',   pos:'Goal Keeper',  num:17,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p18',name:'Mampiti Morai',                pos:'Wing Defence', num:18,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p19',name:'Nontobeko Noluntu Mohlakoana', pos:'Centre',       num:19,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p20',name:'Maria Pebetse Zondo',          pos:'Goal Shooter', num:20,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''},
    {id:'p22',name:'Zinhle Mase',                  pos:'Goal Attack',  num:22,goals:0,attempts:0,assists:0,gp:0,intercepts:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''}
  ]}
};

function ld(k,fb){try{return JSON.parse(localStorage.getItem(k))||fb}catch{return fb}}
function sv(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}}
const $ = id=>document.getElementById(id);

let clubs    = ld('uc_clubs_v7',   SEED_CLUBS);

const CLUB_ORDER=['warriors','gladiators','titans'];
clubs.sort(function(a,b){
  var ai=CLUB_ORDER.indexOf(a.id),bi=CLUB_ORDER.indexOf(b.id);
  if(ai<0)ai=99;if(bi<0)bi=99;return ai-bi;
});
let clubData = ld('uc_data_v7',    SEED_DATA);
let ratings  = ld('uc_ratings_v7', {});
let comments = ld('uc_cmts_v7',    {});
let scorers  = ld('uc_scorers_v7', {});
let lineups  = ld('uc_lineups_v7', {});
let clubDescriptions = ld('uc_clubdesc_v7', {});
let techTeams = ld('uc_techteam_v7', {});
let logs     = ld('uc_logs_v7',    []);
let notifSent= ld('uc_notifs_v7',  {});
let ucLogo   = localStorage.getItem('uc_main_logo') || null;

let isAdmin=false,currentAdmin=null,clubId=null,mdId=null,activeTab='players';
let mdReturnTo=null;
let clubReturnTo=null;
function isOwner(){ return isAdmin && currentAdmin && currentAdmin.role==='Platform Owner'; }
function requireOwner(actionLabel){
  if(!isOwner()){
    showToast('Owner Only', (actionLabel||'This action')+' can only be performed by the Platform Owner.');
    return false;
  }
  return true;
}
let expPlayer=null,spOpen=true,lpOpen=true;
let editingStatsPid=null,editingPicPid=null;
let newLogoData=undefined,newLogoFile=undefined,newPicData=undefined,newUcLogoData=undefined,newUcLogoFile=undefined;
let piNewPhoto=undefined,piNewPhotoFile=undefined,viewingPid=null,editMdId=null;
let newPicFile=undefined;
let logsPage=0; const LOGS_PER_PAGE=25;
let fanId=localStorage.getItem('uc_fan')||('fan_'+Math.random().toString(36).slice(2,10));
localStorage.setItem('uc_fan',fanId);
let timerInterval=null,timerMdId=null;
let standings=ld('uc_standings_v7',{warriors:[],gladiators:[],titans:[]});
// NOTE: standings are loaded fresh from Supabase on init; localStorage is only a brief cache.
let gallery=ld('uc_gallery_v7',[]);
let homeStripHidden = ld('uc_stripstate_v7', {gallery:false, news:false});
function toggleHomeStrip(key){
  homeStripHidden[key] = !homeStripHidden[key];
  sv('uc_stripstate_v7', homeStripHidden);
  applyHomeStripVisibility();
}
function applyHomeStripVisibility(){
  const galBody=$('home-gallery-preview'), galToggle=$('gallery-strip-toggle');
  if(galBody) galBody.style.display = homeStripHidden.gallery ? 'none' : 'grid';
  if(galToggle) galToggle.textContent = homeStripHidden.gallery ? 'Show' : 'Hide';
  const newsBody=$('home-news-preview'), newsToggle=$('news-strip-toggle');
  if(newsBody) newsBody.style.display = homeStripHidden.news ? 'none' : '';
  if(newsToggle) newsToggle.textContent = homeStripHidden.news ? 'Show' : 'Hide';
}
let dbAdmins=[];


function getClub(id){return clubs.find(c=>c.id===id)}
function getData(id){return clubData[id]}
function isNetball(cid){return getClub(cid||clubId)?.sport==='Netball'}

const LEAGUE_DIVISION_PAGE = {
  warriors:   'https://ujcampusleague.leaguerepublic.com/fg/1_457102445.html', // Promo League 2026
  gladiators: 'https://ujcampusleague.leaguerepublic.com/fg/1_885235865.html', // Foundation League Stream A
  titans:     'https://ujinternalnetball.leaguerepublic.com/index.html'         // UJ Internal Netball
};
const LEAGUE_TEAM_LINKS = {
  warriors: {
    'African Star':'https://ujcampusleague.leaguerepublic.com/team/814288916/60630148.html',
    'The Richmond FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/890268894.html',
    'Urban C Warriors FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/32704365.html',
    'Warriors FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/32704365.html',
    'Kilimanjaro':'https://ujcampusleague.leaguerepublic.com/team/814288916/9439592.html',
    'Kingsway Spartans':'https://ujcampusleague.leaguerepublic.com/team/814288916/346928311.html',
    'MVSL All Stars':'https://ujcampusleague.leaguerepublic.com/team/814288916/373495055.html',
    'Cornerstone':'https://ujcampusleague.leaguerepublic.com/team/814288916/7890749.html',
    'Conerstone':'https://ujcampusleague.leaguerepublic.com/team/814288916/7890749.html',
    'Jabali Day House':'https://ujcampusleague.leaguerepublic.com/team/814288916/135757517.html',
    'Eswatini Citizens':'https://ujcampusleague.leaguerepublic.com/team/814288916/766558727.html',
    'UJ Miners':'https://ujcampusleague.leaguerepublic.com/team/814288916/455022107.html',
    'Betrams mews fc':'https://ujcampusleague.leaguerepublic.com/team/814288916/96641266.html',
    'The Waldorfians':'https://ujcampusleague.leaguerepublic.com/team/814288916/429318591.html',
    'UJ CS':'https://ujcampusleague.leaguerepublic.com/team/814288916/698890153.html',
    'The Fields United':'https://ujcampusleague.leaguerepublic.com/team/814288916/658041074.html',
    'K-stay HH Stars FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/344420566.html',
    'Ivory FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/244930332.html'
  },
  gladiators: {
    'Infinity FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/802688774.html',
    'UC Gladiators FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/666916840.html',
    'Gladiators FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/666916840.html',
    'Horizon Heights fc':'https://ujcampusleague.leaguerepublic.com/team/814288916/42587819.html',
    'Twickenham FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/510658161.html',
    'Twelve 91 Ballers fc':'https://ujcampusleague.leaguerepublic.com/team/814288916/735266100.html',
    'Umhlanga FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/178360658.html',
    'Buxton FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/776133314.html',
    'Jacaranda FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/55243718.html',
    'Richmond Central':'https://ujcampusleague.leaguerepublic.com/team/814288916/927201576.html',
    'Beachway FC':'https://ujcampusleague.leaguerepublic.com/team/814288916/864735913.html'
  },
  // UJ Internal Netball – Division A
  titans: {
    'Focus 1 NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/386819841.html',
    'Herb House NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/781649434.html',
    'Richmond Life NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/450987773.html',
    'Karibu Jami NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/153405084.html',
    'The Fields NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/499369831.html',
    'Adowa NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/18508980.html',
    'Ulwazi NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/529225857.html',
    'Ivory Icons NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/859025398.html',
    'Sophiatown NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/997542009.html',
    'Impumelelo NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/751088396.html',
    'Hector Pieterson NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/967462689.html',
    'Horizon Ladies NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/507199898.html',
    'Phumlani Ladies NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/991053982.html',
    'Mill Junction NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/36710037.html',
    // Division B
    'Magnolia NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/168965968.html',
    'Horizon Heights NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/792730946.html',
    'Pro Maths NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/391773320.html',
    'Fedsure NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/173626312.html',
    'Imbewu NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/707845456.html',
    'UC Titans NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/271676179.html',
    'Mosate Heights NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/716884232.html',
    'Betrams Mews':'https://ujinternalnetball.leaguerepublic.com/team/399458521/96118590.html',
    'Betrams Mews NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/96118590.html',
    'Air Ballers NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/380823565.html',
    'Saratoga Village NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/70938225.html',
    'Kingsway Place NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/146629785.html',
    'Truman NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/631124240.html',
    'Akani NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/644777627.html',
    'UJAP SF NC':'https://ujinternalnetball.leaguerepublic.com/team/399458521/753971556.html'
  }
};

function leagueLinkFor(clubId,teamName){
  const map=LEAGUE_TEAM_LINKS[clubId];
  if(!map)return null;
  const norm=s=>(s||'').toLowerCase().replace(/\s+/g,' ').trim();
  const target=norm(teamName);
  if(!target)return LEAGUE_DIVISION_PAGE[clubId]||null;
  for(const name in map){ if(norm(name)===target) return map[name]; }
  for(const name in map){ const n=norm(name); if(n.includes(target)||target.includes(n)) return map[name]; }
  return LEAGUE_DIVISION_PAGE[clubId]||null;
}

function teamNameLinkH(clubId,teamName){
  const url=leagueLinkFor(clubId,teamName);
  const safe=(teamName||'').replace(/</g,'&lt;');
  if(!url)return safe;
  return '<a href="'+url+'" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dotted currentColor" onclick="event.stopPropagation()" title="View on UJ Campus League">'+safe+'</a>';
}
function compRating(map){const v=Object.values(map||{});return v.length?Math.min(5,v.reduce((s,r)=>s+r.stars,0)/v.length):0}
function overallRating(cid,pid){return compRating(ratings[cid+'_'+pid]||{})}
function mdRating(cid,mid,pid){return compRating(ratings[cid+'_'+mid+'_'+pid]||{})}
// The signed-in fan's OWN rating for this player in this match — distinct
// from mdRating, which is the average across every fan who's rated them.
// The interactive star widget must reflect the fan's own vote, not the
// crowd average, or it looks pre-filled/"already voted" to every new fan
// and looks like their tap "didn't register" once the average shifts to
// a different rounded value than what they actually tapped.
function myRating(cid,mid,pid){
  const entry=(ratings[cid+'_'+mid+'_'+pid]||{})[fanId];
  return entry?entry.stars:0;
}
async function rateP(cid,mid,pid,stars){
  ratings[cid+'_'+mid+'_'+pid]={...(ratings[cid+'_'+mid+'_'+pid]||{}),[fanId]:{stars,ts:Date.now()}};
  ratings[cid+'_'+pid]={...(ratings[cid+'_'+pid]||{}),[fanId+'_'+mid]:{stars,ts:Date.now()}};
  sv('uc_ratings_v7',ratings);
  if(dbConnected){
    try{
      await dbPostRating(cid,mid,pid,stars);
    }catch(e){
      console.warn('dbPostRating failed, retrying once:',e.message);
      try{
        await new Promise(r=>setTimeout(r,1200));
        await dbPostRating(cid,mid,pid,stars);
      }catch(e2){
        console.error('dbPostRating failed twice:',e2.message);
        showToast('Rating Not Saved',"Your rating didn't reach the server. Check your connection and try tapping the stars again.");
      }
    }
  }
}
function rcol(res){
  if(!res)return{fg:'#999',bg:'#f5f5f5'};
  if(res.includes('W'))return{fg:'#2ecc71',bg:'#e8faf0'};
  if(res.includes('D'))return{fg:'#f39c12',bg:'#fff8e0'};
  return{fg:'#e74c3c',bg:'#fdecea'};
}
function logoSrc(club){return club.logo||DEF_LOGOS[club.id]||''}
function starsH(val,sz,click,cid,mid,pid){
  const r=Math.round(val);let h='<div class="stars">';
  for(let i=1;i<=5;i++){
    if(click)h+=`<span class="star ${i<=r?'on':'off'} click" style="font-size:${sz}px" onclick="doRate('${cid}','${mid}','${pid}',${i})" onmouseover="hvStars(this.parentNode,${i})" onmouseout="resetStarsEl(this.parentNode,'${cid}','${mid}','${pid}')">&#9733;</span>`;
    else h+=`<span class="star ${i<=r?'on':'off'}" style="font-size:${sz}px">&#9733;</span>`;
  }
  return h+'</div>';
}
function hvStars(el,hov){el.querySelectorAll('.star').forEach((s,i)=>{s.className='star '+(i<hov?'on':'off')+' click'})}
function resetStarsEl(el,cid,mid,pid){const v=myRating(cid,mid,pid);el.querySelectorAll('.star').forEach((s,i)=>{s.className='star '+(i<v?'on':'off')+' click'})}
function avH(name,img,sz,pri,acc){
  const ini=name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const fs=Math.round(sz*.33);
  if(img)return`<div class="av" style="width:${sz}px;height:${sz}px;border-color:${acc};background:${pri}"><img src="${img}" alt="${name}"/></div>`;
  return`<div class="av" style="width:${sz}px;height:${sz}px;border-color:${acc};background:${pri};color:${acc};font-family:'Oswald',sans-serif;font-size:${fs}px;font-weight:700">${ini}</div>`;
}
function logoH(club,sz){return`<img src="${logoSrc(club)}" alt="${club.name}" style="width:${sz}px;height:${sz}px;object-fit:contain;border-radius:10px;flex-shrink:0"/>`}
function fmtKickoff(md){if(!md.date)return '';const t=md.kickoffTime?' @ '+md.kickoffTime:'';return md.date+t}
function getDuration(md){return DURATION_MAP[md.durationKey||'90']||DURATION_MAP['90']}
function isMatchPaused(md){ return !!(md&&md.htPaused); }
function pausedBreakLabel(md){
  const dur=getDuration(md);
  if(dur.sport==='Netball') return 'Break';
  return 'Half-Time';
}

function ordinalWord(n){
  const words=['First','Second','Third','Fourth','Fifth','Sixth'];
  return words[n-1]||(n+'th');
}
function getLiveClockInfo(md){
  if(!md||md.status!=='live'||!md.matchStartedAt) return {running:false};
  const dur=getDuration(md);
  const totalSecs=dur.mins*60;
  const halfSecs=Math.floor(totalSecs/dur.halves);
  const nowMs=Date.now();
  const halfStart=md.halfStartedAt||md.matchStartedAt;
  const paused=!!md.htPaused;
  const pauseStart=md.htPauseStart||0;
  const pausedTotal=md.htPausedTotal||0; // seconds paused so far *within this half*
  const extraPause=paused?Math.max(0,nowMs-pauseStart):0;
  const elapsedInHalf=Math.max(0,Math.floor(((nowMs-halfStart)-(pausedTotal*1000)-extraPause)/1000));
  const currentHalf=Math.min(dur.halves,md.currentHalf||1);
  const atCap=elapsedInHalf>=halfSecs;
  const cumulativeBase=(currentHalf-1)*halfSecs; // e.g. 1800s once half 2 begins
  const isNB=dur.sport==='Netball';
  const halfLabel=isNB?('Quarter '+currentHalf+' of '+dur.halves):(ordinalWord(currentHalf)+' Half');
  const breakLabel=isNB
    ?(currentHalf===1?'Q1/Q2 Break':currentHalf===2?'Half Time':currentHalf===3?'Q3/Q4 Break':'Break')
    :'Half Time';
  let timeStr=null;
  if(!paused){
    if(atCap){
      const extraMins=Math.floor((elapsedInHalf-halfSecs)/60);
      timeStr=Math.floor((cumulativeBase+halfSecs)/60)+'+'+extraMins+"'";
    } else {
      const cum=cumulativeBase+elapsedInHalf;
      const mm=Math.floor(cum/60),ss=cum%60;
      timeStr=mm+':'+(ss<10?'0':'')+ss;
    }
  }
  const atBreak=!paused&&atCap&&currentHalf<dur.halves;
  const pct=Math.min(100,((cumulativeBase+Math.min(elapsedInHalf,halfSecs))/totalSecs)*100);
  return {running:true,timeStr,halfLabel,breakLabel,paused,atBreak,pct,dur,currentHalf,halfSecs,elapsedInHalf,cumulativeBase};
}
// Current whole-number match minute (1-indexed, matching how goals are
// conventionally marked e.g. "12'"), computed straight from the live
// match clock — used so admins never have to type the minute by hand.
// Returns null if the match isn't currently live/running.
function getCurrentMatchMinute(md){
  const info=getLiveClockInfo(md);
  if(!info.running||info.paused) return null;
  const totalSecs=info.cumulativeBase+info.elapsedInHalf;
  return Math.floor(totalSecs/60)+1;
}
function liveBadgeH(md,sz){
  sz=sz||'';
  const paused=isMatchPaused(md);
  if(paused){
    return '<span class="live-badge paused-badge" style="'+sz+'"><span class="pause-icon">&#10074;&#10074;</span>'+pausedBreakLabel(md)+'</span>';
  }
  return '<span class="live-badge"'+(sz?' style="'+sz+'"':'')+'><span class="live-dot"></span>LIVE</span>';
}
function posCategory(pos){
  if(!pos) return 'outfield';
  const p = pos.toLowerCase();
  if(p.includes('goalkeeper') || p.includes('keeper')) return 'gk';
  if(p.includes('back') || p.includes('defen') || p==='cb' || p==='lb' || p==='rb') return 'def';
  return 'outfield'; // midfielders, wingers, forwards, strikers
}
function getStatFields(cid, pos){
  if(isNetball(cid)){
    return [{key:'goals',lbl:'Goals'},{key:'attempts',lbl:'Attempts'},{key:'assists',lbl:'Assists'},{key:'gp',lbl:'Games',computed:true},{key:'intercepts',lbl:'Intercepts'}];
  }
  const cat = posCategory(pos);
  if(cat === 'gk'){
    return [
      {key:'gp',lbl:'Games',computed:true},
      {key:'goalsConceded',lbl:'Conceded'},
      {key:'saves',lbl:'Saves'},
      {key:'cleanSheets',lbl:'Clean Sheets'},
      {key:'cleanSheetPct',lbl:'CS %',computed:true},
      {key:'goals',lbl:'Goals'},
      {key:'assists',lbl:'Assists'},
      {key:'yellowCards',lbl:'YC'},
      {key:'redCards',lbl:'RC'}
    ];
  }
  if(cat === 'def'){
    return [
      {key:'gp',lbl:'Games',computed:true},
      {key:'goals',lbl:'Goals'},
      {key:'assists',lbl:'Assists'},
      {key:'goalsConceded',lbl:'Conceded'},
      {key:'yellowCards',lbl:'YC'},
      {key:'redCards',lbl:'RC'}
    ];
  }
  // Midfielders / Forwards / Wingers / Strikers
  return [
    {key:'gp',lbl:'Games',computed:true},
    {key:'goals',lbl:'Goals'},
    {key:'assists',lbl:'Assists'},
    {key:'yellowCards',lbl:'YC'},
    {key:'redCards',lbl:'RC'}
  ];
}
function computeStatValue(p, f, cid){
  if(f.key === 'gp'){
    return cid ? getPlayerAppearances(cid, p.id) : (p.gp||0);
  }
  if(f.key === 'cleanSheetPct'){
    const gp = cid ? getPlayerAppearances(cid, p.id) : (p.gp||0);
    const cs = p.cleanSheets || 0;
    return gp > 0 ? Math.round((cs/gp)*100) + '%' : '0%';
  }
  return p[f.key] || 0;
}
function statsGridH(p,cid){
  const fields=getStatFields(cid,p.pos);
  const cls=isNetball(cid)?'netball-stats':('football-stats stat-count-'+fields.length);
  return`<div class="pc-stats ${cls}">${fields.map(f=>`<div class="stat-cell"><div class="stat-num">${computeStatValue(p,f,cid)}</div><div class="stat-lbl">${f.lbl}</div></div>`).join('')}</div>`;
}

function writeLog(action,category,details={}){
  if(dbConnected){ dbWriteLog(action,category,details||{}); }
  logs.unshift({id:Date.now().toString(),action,category,club_id:details.club_id||clubId||null,matchday_id:details.matchday_id||mdId||null,player_id:details.player_id||null,fan_id:fanId,details,ts:new Date().toISOString()});
  if(logs.length>500)logs=logs.slice(0,500);
  sv('uc_logs_v7',logs);
}


function reqNotifPerm(){if('Notification'in window&&Notification.permission==='default')Notification.requestPermission()}
function sendNotif(title,body){showToast(title,body);if('Notification'in window&&Notification.permission==='granted'){try{new Notification(title,{body})}catch{}}}
function showToast(title,body){
  const wrap=$('toast-wrap'),el=document.createElement('div');el.className='toast';
  el.innerHTML=`<div class="toast-title">${title}</div><div class="toast-body">${body||''}</div>`;
  wrap.appendChild(el);
  setTimeout(()=>{el.classList.add('removing');setTimeout(()=>el.remove(),300)},4000);
}

function kickoffMs(md){if(!md.date)return 0;const t=md.kickoffTime||'00:00';return new Date(md.date+'T'+t).getTime()}
function ratingOpenMs(md){return md.ratingOpenOverride||kickoffMs(md)}
function ratingCloseMs(md){if(md.forceOpen)return Infinity;if(md.forceClose)return 0;const o=ratingOpenMs(md);if(!o)return 0;return o+(md.ratingWindowHrs||24)*3600000}
function isRatingOpen(md){
  if(md.forceOpen)return true;
  if(md.forceClose||md.status==='finished')return false;
  if(md.status==='live')return true;
  const now=Date.now(),o=ratingOpenMs(md),c=ratingCloseMs(md);
  return o>0&&now>=o&&now<c;
}
function ratingClosesIn(md){
  const c=ratingCloseMs(md);if(!c)return 'Closed';
  const ms=c-Date.now();if(ms<=0)return 'Closed';
  const hrs=Math.floor(ms/3600000),mins=Math.floor((ms%3600000)/60000);
  return `Closes in ${hrs}h ${mins}m`;
}
function ratingOpensIn(md){
  const o=ratingOpenMs(md);if(!o)return '';
  const ms=o-Date.now();if(ms<=0)return 'now';
  const hrs=Math.floor(ms/3600000),mins=Math.floor((ms%3600000)/60000);
  return hrs>24?`in ${Math.floor(hrs/24)}d ${hrs%24}h`:`in ${hrs}h ${mins}m`;
}

function startTimer(md){
  stopTimer();
  if(!md||md.status!=='live')return;
  timerMdId=md.id;
  timerInterval=setInterval(function(){
    const fresh=getData(clubId)?.matchdays?.find(m=>m.id===timerMdId);
    if(!fresh){stopTimer();return;}
    updateTimerDisplay(fresh);
  },250);
  updateTimerDisplay(md);
}
function stopTimer(){if(timerInterval){clearInterval(timerInterval);timerInterval=null;}timerMdId=null;const bar=$('live-timer-bar');if(bar)bar.style.display='none';}
function updateTimerDisplay(md){
  var bar=$('live-timer-bar');
  if(!bar||md.status!=='live'){stopTimer();return;}
  bar.style.display='';
  var info=getLiveClockInfo(md);
  if(!info.running){
    bar.innerHTML=
      '<div class="timer-main">'+
        '<div class="timer-display" style="color:#999;min-width:80px;font-size:16px">NOT STARTED</div>'+
        '<div class="timer-info"><div class="timer-period">Waiting for kickoff</div>'+
        '<div class="timer-quarter" style="color:#888">'+getDuration(md).label+' &middot; '+getDuration(md).sport+'</div></div>'+
        (isAdmin?'<button onclick="openManageMatch()" style="padding:5px 16px;border-radius:7px;border:1.5px solid #2ecc71;color:#2ecc71;background:#fff;font-size:12px;font-weight:700;cursor:pointer;margin-left:10px">&#9654; Go Live</button>':'')+
      '</div>';
    return;
  }
  var dur=info.dur;
  // Admin controls
  var adminCtrl='';
  if(isAdmin){
    if(info.paused){
      adminCtrl='<button onclick="resumeTimer(\''+mdId+'\')" style="padding:5px 16px;border-radius:7px;border:1.5px solid #2ecc71;color:#2ecc71;background:#fff;font-size:12px;font-weight:700;cursor:pointer;margin-left:10px">&#9654; Resume</button>';
    } else if(info.atBreak){
      adminCtrl='<button onclick="pauseTimer(\''+mdId+'\')" style="padding:5px 16px;border-radius:7px;border:1.5px solid #f39c12;color:#f39c12;background:#fff;font-size:12px;font-weight:700;cursor:pointer;margin-left:10px;animation:pulse 1.2s infinite">&#9646;&#9646; '+info.breakLabel+'</button>';
    } else {
      adminCtrl='<button onclick="pauseTimer(\''+mdId+'\')" style="padding:5px 14px;border-radius:7px;border:1.5px solid #e74c3c;color:#e74c3c;background:#fff;font-size:12px;font-weight:700;cursor:pointer;margin-left:10px">&#9646;&#9646; Pause</button>';
    }
  }
  var timerColor=info.paused?'#f39c12':'var(--c-accent)';
  var badge=info.paused
    ?'<span style="background:#f39c12;color:#fff;font-size:10px;font-weight:800;padding:3px 10px;border-radius:20px;letter-spacing:1px">PAUSED</span>'
    :'<span class="live-badge"><span class="live-dot"></span>LIVE</span>';
  // While paused for a half-time/break, the numeric clock is hidden — the
  // break name is shown in its place instead of a stale frozen number.
  var clockDisplay=info.paused
    ?'<div class="timer-display" style="color:#f39c12;min-width:80px;font-size:17px;letter-spacing:.5px">'+info.breakLabel.toUpperCase()+'</div>'
    :'<div class="timer-display" style="color:'+timerColor+';min-width:80px">'+info.timeStr+'</div>';
  var pauseBanner=info.paused
    ?'<div style="background:#fff8e0;border:1.5px solid #f39c12;border-radius:8px;padding:8px 14px;margin-top:8px;font-size:13px;font-weight:700;color:#b8860b;display:flex;align-items:center;gap:8px">'+
      '&#9646;&#9646; '+info.breakLabel+' — Match paused'+
      (isAdmin?'<button onclick="resumeTimer(\''+mdId+'\')" style="margin-left:auto;padding:4px 14px;border-radius:7px;border:1.5px solid #2ecc71;color:#2ecc71;background:#fff;font-size:12px;font-weight:700;cursor:pointer">&#9654; Resume</button>':'')+
      '</div>'
    :'';
  bar.innerHTML=
    '<div class="timer-main">'+
      clockDisplay+
      '<div class="timer-info">'+
        '<div class="timer-period">'+info.halfLabel+'</div>'+
        '<div class="timer-quarter" style="color:#888">'+dur.label+' &middot; '+dur.sport+'</div>'+
      '</div>'+
      badge+adminCtrl+
    '</div>'+
    '<div class="timer-progress" style="margin-top:8px">'+
      '<div class="timer-progress-fill" style="width:'+info.pct+'%;background:'+timerColor+'"></div>'+
    '</div>'+
    pauseBanner;
}


let mmInterval = null;

function openManageMatch(){
  const club = getClub(clubId);
  const md = getData(clubId)?.matchdays?.find(m => m.id === mdId);
  if(!club || !md) return;

  $('mm-home-lbl').textContent = club.short;
  $('mm-away-lbl').textContent = md.opponent || 'Away';
  $('mm-home-val').textContent = md.homeGoals || 0;
  $('mm-away-val').textContent = md.awayGoals || 0;

  document.querySelectorAll('.mm-status-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.status === md.status);
  });

  $('mm-danger-zone').style.display = isOwner() ? '' : 'none';

  mmRenderClock(md);
  if(mmInterval) clearInterval(mmInterval);
  mmInterval = setInterval(() => mmRenderClock(getData(clubId)?.matchdays?.find(m => m.id === mdId)), 1000);

  openModal('m-manage-match');
}

function mmRenderClock(md){
  if(!md) return;
  const box = $('mm-clock-status');
  const ctrls = $('mm-clock-controls');
  if(!box || !ctrls) return;

  if(md.status !== 'live'){
    box.innerHTML = '<div class="mm-clock-period">Press &ldquo;Go Live&rdquo; below to start the match clock</div>';
    ctrls.innerHTML = '';
    return;
  }
  const info = getLiveClockInfo(md);
  if(!info.running){
    box.innerHTML = '<div class="mm-clock-period">Clock hasn\'t started yet</div>';
    ctrls.innerHTML = '<button onclick="goLiveStart()" style="border-color:#2ecc71;color:#2ecc71">&#9654; Go Live (start clock)</button>';
    return;
  }

  if(info.paused){
    box.innerHTML = '<div class="mm-clock-time" style="color:#f39c12;font-size:22px;letter-spacing:.5px">' + info.breakLabel.toUpperCase() + '</div>' +
      '<div class="mm-clock-period">' + info.halfLabel + ' &middot; PAUSED</div>';
    ctrls.innerHTML = '<button onclick="resumeTimer(mdId)" style="border-color:#2ecc71;color:#2ecc71">&#9654; Resume Match</button>';
  } else {
    box.innerHTML = '<div class="mm-clock-time" style="color:var(--c-accent,#4dc8c8)">' + info.timeStr + '</div>' +
      '<div class="mm-clock-period">' + info.halfLabel + '</div>';
    const label = info.atBreak
      ? (info.dur.sport === 'Netball' ? 'Pause for Break' : 'Pause for Half-Time')
      : 'Pause Clock';
    ctrls.innerHTML = '<button onclick="pauseTimer(mdId)" style="border-color:#f39c12;color:#f39c12">' + label + '</button>';
  }
}

async function mmAdjustScore(side, delta){
  const md = clubData[clubId].matchdays.find(m => m.id === mdId);
  if(!md) return;
  const key = side === 'home' ? 'homeGoals' : 'awayGoals';
  md[key] = Math.max(0, (md[key] || 0) + delta);
  $('mm-' + side + '-val').textContent = md[key];
  if(dbConnected){ await dbSaveMatchday(clubId, {...md, _dbId: md._dbId || mdId}); }
  sv('uc_data_v7', clubData);
  writeLog('score_adjusted', 'matchday', {matchday_id: mdId, details: {side, delta}});
  renderMd();
}

async function mmSetStatus(status){
  const md = clubData[clubId].matchdays.find(m => m.id === mdId);
  if(!md) return;
  const oldStatus = md.status;
  md.status = status;
  if(status === 'live' && oldStatus !== 'live'){
    md.matchStartedAt = Date.now();
    md.currentHalf = 1;
    md.halfStartedAt = Date.now();
    md.htPaused = false; md.htPauseStart = 0; md.htPausedTotal = 0;
  }
  document.querySelectorAll('.mm-status-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.status === status);
  });
  if(dbConnected){ await dbSaveMatchday(clubId, {...md, _dbId: md._dbId || mdId}); }
  sv('uc_data_v7', clubData);
  writeLog('status_changed', 'matchday', {matchday_id: mdId, details: {status}});
  if(status === 'live' && oldStatus !== 'live'){
    const club = getClub(clubId);
    sendNotif('Match is LIVE', (club ? club.short : '') + ' vs ' + (md.opponent || '') + ' - rate now!');
  }
  mmRenderClock(md);
  if(status === 'live') startTimer(md); else stopTimer();
  renderMd();
  renderMatchdays();
  updateLiveIndicator();
}

async function goLiveStart(){
  const md = clubData[clubId]?.matchdays?.find(m => m.id === mdId);
  if(!md) return;
  md.matchStartedAt = Date.now();
  md.currentHalf = 1;
  md.halfStartedAt = Date.now();
  md.htPaused = false; md.htPauseStart = 0; md.htPausedTotal = 0;
  if(dbConnected){ await dbSaveMatchday(clubId, {...md, _dbId: md._dbId || mdId}); }
  sv('uc_data_v7', clubData);
  writeLog('match_started', 'matchday', {matchday_id: mdId});
  mmRenderClock(md);
  startTimer(md);
  renderMd();
}

async function pauseTimer(mdId2){
  const d=getData(clubId),md2=d&&d.matchdays?d.matchdays.find(function(m){return m.id===mdId2;}):null;
  if(!md2||md2.htPaused)return;
  md2.htPaused=true;
  md2.htPauseStart=Date.now();
  sv('uc_data_v7',clubData);
  if(dbConnected){ await dbSaveMatchday(clubId,{...md2,_dbId:md2._dbId||md2.id}); }
  writeLog('match_paused','matchday',{matchday_id:mdId2});
  showToast('Match Paused',pausedBreakLabel(md2)+' — click Resume when ready.');
  refreshClockUI(md2);
}
async function resumeTimer(mdId2){
  const d=getData(clubId),md2=d&&d.matchdays?d.matchdays.find(function(m){return m.id===mdId2;}):null;
  if(!md2||!md2.htPaused)return;
  const dur=getDuration(md2);
  const halfSecs=Math.floor((dur.mins*60)/dur.halves);
  const halfStart=md2.halfStartedAt||md2.matchStartedAt;
  const pausedTotalBefore=md2.htPausedTotal||0;
  const elapsedInHalfAtPause=Math.max(0,Math.floor(((md2.htPauseStart-halfStart)-(pausedTotalBefore*1000))/1000));
  const wasAtHalfBreak=elapsedInHalfAtPause>=halfSecs&&(md2.currentHalf||1)<dur.halves;
  const justPausedSecs=Math.max(0,Math.floor((Date.now()-md2.htPauseStart)/1000));
  if(wasAtHalfBreak){
    // Resuming into the next half/quarter: the clock continues from where
    // this half capped out (e.g. 30:00 → counts up to 60:00), it does NOT
    // reset to 0:00.
    md2.currentHalf=(md2.currentHalf||1)+1;
    md2.halfStartedAt=Date.now();
    md2.htPausedTotal=0;
  } else {
  
    md2.htPausedTotal=pausedTotalBefore+justPausedSecs;
  }
  md2.htPaused=false;md2.htPauseStart=0;
  sv('uc_data_v7',clubData);
  if(dbConnected){ await dbSaveMatchday(clubId,{...md2,_dbId:md2._dbId||md2.id}); }
  writeLog('match_resumed','matchday',{matchday_id:mdId2});
  showToast('Match Resumed',wasAtHalfBreak?(dur.sport==='Netball'?('Quarter '+md2.currentHalf+' underway!'):(ordinalWord(md2.currentHalf)+' Half underway!')):'Play resumed!');
  refreshClockUI(md2);
}

function refreshClockUI(md){
  if(mdId===md.id) updateTimerDisplay(md);
  if($('m-manage-match')?.classList.contains('open')) mmRenderClock(md);
  if(document.getElementById('view-home')?.classList.contains('active')) renderHome();
}


const NOTIF_THRESHOLDS=[
  {ms:60*60*1000, key:'60m'},
  {ms:30*60*1000, key:'30m'},
  {ms:15*60*1000, key:'15m'},
  {ms:10*60*1000, key:'10m'},
  {ms:5*60*1000,  key:'5m'},
  {ms:1*60*1000,  key:'1m'}
];
function formatCountdown(ms){
  if(ms<=0)return'now';
  const totalSec=Math.round(ms/1000);
  const h=Math.floor(totalSec/3600),m=Math.floor((totalSec%3600)/60),s=totalSec%60;
  if(h>0)return h+' hour'+(h>1?'s':'')+(m>0?' '+m+' min':'');
  if(m>0)return m+' minute'+(m!==1?'s':'');
  return s+' second'+(s!==1?'s':'');
}
function checkScheduledNotifs(){
  const now=Date.now();
  clubs.forEach(club=>{
    (getData(club.id)?.matchdays||[]).forEach(md=>{
      const ko=kickoffMs(md);if(!ko)return;
      if(md.status==='upcoming'){
        NOTIF_THRESHOLDS.forEach(function(th){
          const k=club.id+'_'+md.id+'_'+th.key,remaining=ko-now;
          if(!notifSent[k]&&remaining>0&&remaining<=th.ms){
            notifSent[k]=true;sv('uc_notifs_v7',notifSent);
            sendNotif('Match Starting Soon',`${club.short} vs ${md.opponent} starts in ${formatCountdown(remaining)}!`);
          }
        });
      }
     
      const closeMs=ratingCloseMs(md);
      if(closeMs&&now>=closeMs&&md.status==='live'){
        md.status='finished';sv('uc_data_v7',clubData);
        if(dbConnected){ dbSaveMatchday(club.id,{...md,_dbId:md._dbId||md.id}); }
        const closeKey=club.id+'_'+md.id+'_closed';
        if(!notifSent[closeKey]){notifSent[closeKey]=true;sv('uc_notifs_v7',notifSent);sendNotif('Ratings Closed',`Rating window for ${club.short} vs ${md.opponent} ended.`);}
        if(clubId===club.id&&mdId===md.id){stopTimer();renderMd();}
      }
    });
  });
  updateLiveIndicator();
}
// Checked every 10s so the "starts in X minutes" wording stays accurate
// and live/finished transitions feel near-instant without a page reload.
setInterval(checkScheduledNotifs,15000);
function updateLiveIndicator(){
  let anyLive=false;
  clubs.forEach(c=>{(getData(c.id)?.matchdays||[]).forEach(m=>{if(m.status==='live')anyLive=true})});
  $('live-pill').style.display=anyLive?'':'none';

  if('setAppBadge' in navigator){
    if(anyLive) navigator.setAppBadge(1).catch(()=>{});
    else navigator.clearAppBadge().catch(()=>{});
  }

  renderPinnedBar();
}

let pinnedDismissed = ld('uc_pinned_dismissed_v1', []);
function getLiveMatchesAll(){
  const out=[];
  clubs.forEach(c=>{(getData(c.id)?.matchdays||[]).forEach(m=>{ if(m.status==='live') out.push({club:c, md:m}); }); });
  return out;
}
function renderPinnedBar(){
  const bar=$('pinned-score-bar');if(!bar)return;
  const liveIds=getLiveMatchesAll().map(x=>x.md.id);
  pinnedDismissed=pinnedDismissed.filter(id=>liveIds.includes(id));
  sv('uc_pinned_dismissed_v1',pinnedDismissed);

  const candidates=getLiveMatchesAll().filter(x=>!pinnedDismissed.includes(x.md.id));
  const visible=candidates.filter(x=>!(clubId===x.club.id&&mdId===x.md.id));

  if(!visible.length){
    bar.style.display='none';bar.innerHTML='';
    document.body.classList.remove('has-pinned-bar');
    return;
  }
  const {club,md}=visible[0];
  const info=getLiveClockInfo(md);
  const clockTxt=info.running?(info.paused?'HT':info.timeStr):'LIVE';
  bar.dataset.cid=club.id;bar.dataset.mid=md.id;
  bar.innerHTML=`<div class="psb-row" onclick="tapPinnedBar(this.parentElement.dataset.cid,this.parentElement.dataset.mid)">
    <span class="psb-live-dot"></span>
    <span class="psb-teams">${club.short} vs ${md.opponent||'TBD'}</span>
    <span class="psb-score">${md.homeGoals||0} - ${md.awayGoals||0}</span>
    <span class="psb-clock" id="psb-clock-text">${clockTxt}</span>
    <button class="psb-close" onclick="event.stopPropagation();dismissPinnedBar('${md.id}')">&times;</button>
  </div>`;
  bar.style.display='';
  document.body.classList.add('has-pinned-bar');
}
function dismissPinnedBar(mid){
  if(!pinnedDismissed.includes(mid)) pinnedDismissed.push(mid);
  sv('uc_pinned_dismissed_v1',pinnedDismissed);
  renderPinnedBar();
}
function tickPinnedBarClock(){
  const bar=$('pinned-score-bar');if(!bar||bar.style.display==='none')return;
  const cid=bar.dataset.cid,mid=bar.dataset.mid;if(!cid||!mid)return;
  const md=getData(cid)?.matchdays?.find(m=>m.id===mid);
  const clockEl=$('psb-clock-text');if(!md||!clockEl)return;
  const info=getLiveClockInfo(md);
  clockEl.textContent=info.running?(info.paused?'HT':info.timeStr):'LIVE';
}
setInterval(tickPinnedBarClock,1000);
function tickScorerMinuteField(){
  const field=$('sc-m');if(!field||!field.readOnly)return;
  const md=getData(clubId)?.matchdays?.find(m=>m.id===mdId);if(!md)return;
  const liveMin=getCurrentMatchMinute(md);
  if(liveMin!=null) field.value=liveMin;
}
setInterval(tickScorerMinuteField,1000);

let homeLiveClockInterval=null;
function startHomeLiveClocks(){
  if(homeLiveClockInterval)clearInterval(homeLiveClockInterval);
  homeLiveClockInterval=setInterval(tickHomeLiveClocks,1000);
}
function tickHomeLiveClocks(){
  if(!document.getElementById('view-home')?.classList.contains('active'))return;
  document.querySelectorAll('.live-timer[data-cid][data-mid]').forEach(function(el){
    const cid=el.getAttribute('data-cid'),mid=el.getAttribute('data-mid');
    const md=getData(cid)?.matchdays?.find(m=>m.id===mid);
    if(!md)return;
    const info=getLiveClockInfo(md);
    if(!info.running){ el.textContent='LIVE'; return; }
    el.textContent=info.paused?'HT':info.timeStr;
  });
}

function renderBrandLogo(){
  const wrap=$('brand-logo-wrap');
  if(ucLogo)wrap.innerHTML=`<img class="brand-logo" src="${ucLogo}" alt="UC Sports"/>`;
  else wrap.innerHTML=`<div class="brand-logo-placeholder">UC</div>`;
}
function openUcLogoModal(){
  newUcLogoData=undefined;newUcLogoFile=undefined;
  const wrap=$('uc-logo-preview-wrap');
  wrap.innerHTML=ucLogo?`<img class="uc-logo-preview" src="${ucLogo}" alt="UC Logo"/>`:`<div class="uc-logo-placeholder">UC</div>`;
  openModal('m-uc-logo');
}
function onUcLogoUpload(e){const file=e.target.files[0];if(!file)return;newUcLogoFile=file;const r=new FileReader();r.onload=ev=>{newUcLogoData=ev.target.result;$('uc-logo-preview-wrap').innerHTML=`<img class="uc-logo-preview" src="${newUcLogoData}" alt="UC Logo"/>`;};r.readAsDataURL(file);}
function removeUcLogo(){newUcLogoData=null;newUcLogoFile=undefined;$('uc-logo-preview-wrap').innerHTML=`<div class="uc-logo-placeholder">UC</div>`;}
async function saveUcLogo(){
  if(newUcLogoData===null){
    ucLogo=null;
    localStorage.removeItem('uc_main_logo');
    renderBrandLogo();
    if(dbConnected){ await dbSaveSetting('uc_logo',''); }
  } else if(newUcLogoFile){
    try{
      ucLogo = await uploadImageToStorage(newUcLogoFile, 'branding');
      localStorage.setItem('uc_main_logo',ucLogo);
      renderBrandLogo();
      if(dbConnected){ await dbSaveSetting('uc_logo',ucLogo); }
    }catch(e){
      showToast('Logo Upload Failed', e.message||'Could not upload logo.');
      return;
    }
  }
  cm('m-uc-logo');showToast('Logo Updated','Main logo saved successfully.');
}

async function loadSettingsFromDB(){
  try{
    const rows=await sb('GET','settings',{eq:{key:'uc_logo'},select:'value'});
    if(rows&&rows.length&&rows[0].value){
      ucLogo=rows[0].value;
      localStorage.setItem('uc_main_logo',ucLogo);
    }
  }catch(e){ console.warn('loadSettingsFromDB failed:',e.message); }
}
async function dbSaveSetting(key,value){
  try{
    const existing=await sb('GET','settings',{eq:{key},select:'key'});
    if(existing&&existing.length){ await sb('PATCH','settings',{eq:{key},data:{value}}); }
    else { await sb('POST','settings',{data:{key,value}}); }
    return true;
  }catch(e){ console.warn('dbSaveSetting failed:',e.message); return false; }
}
async function dbGetSetting(key){
  try{
    const rows=await sb('GET','settings',{eq:{key},select:'value'});
    return rows&&rows.length?rows[0].value:null;
  }catch(e){ console.warn('dbGetSetting failed:',key,e.message); return null; }
}
async function loadClubDescFromDB(cid){
  const v=await dbGetSetting('club_desc_'+cid);
  if(v!=null){ clubDescriptions[cid]=v; sv('uc_clubdesc_v7',clubDescriptions); }
}
async function saveClubDescToDB(cid,text){
  if(!dbConnected) return;
  await dbSaveSetting('club_desc_'+cid, text);
}
async function loadTechTeamFromDB(cid){
  const v=await dbGetSetting('techteam_'+cid);
  if(v!=null){
    try{ techTeams[cid]=JSON.parse(v)||[]; }catch(e){ techTeams[cid]=[]; }
    sv('uc_techteam_v7',techTeams);
  }
}
async function saveTechTeamToDB(cid){
  if(!dbConnected) return;
  await dbSaveSetting('techteam_'+cid, JSON.stringify(techTeams[cid]||[]));
}

function showV(id){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));$('view-'+id).classList.add('active');renderPinnedBar();}
function goHome(){clubId=null;mdId=null;stopTimer();$('back-btn').style.display='none';$('hdr-sep').style.display='none';$('hdr-club').style.display='none';document.documentElement.style.removeProperty('--c-accent');document.documentElement.style.removeProperty('--c-primary');showV('home');renderHome();}
function resetHdrForHub(){
  $('back-btn').style.display='none';$('hdr-sep').style.display='none';$('hdr-club').style.display='none';
  document.documentElement.style.removeProperty('--c-accent');document.documentElement.style.removeProperty('--c-primary');
}
function goBack(){
  if(mdId){
    mdId=null;stopTimer();
    if(mdReturnTo){
      const rt=mdReturnTo;mdReturnTo=null;
      if(rt.view==='logshub'){showV('logshub');switchLogsTab(rt.tab);return;}
      if(rt.view==='newshub'){clubId=null;resetHdrForHub();showV('newshub');renderNewsHub();return;}
      if(rt.view==='gallery'){clubId=null;resetHdrForHub();openGalleryView();return;}
      if(rt.view==='leaderboard'){clubId=null;resetHdrForHub();openLeaderboardHub();return;}
      if(rt.view==='home'){goHome();return;}
    }
    showV('club');renderClub();
  } else if(clubReturnTo){
    const rt=clubReturnTo;clubReturnTo=null;
    if(rt.view==='newshub'){
      clubId=null;stopTimer();
      resetHdrForHub();
      showV('newshub');renderNewsHub();
    } else {
      goHome();
    }
  } else goHome();
}
async function enterClub(id,returnTo){
  clubId=id;mdId=null;activeTab='players';clubReturnTo=returnTo||null;const c=getClub(id);
  if(dbConnected){ await loadClubDataFromDB(id); await loadStandingsFromDB(id); }
  document.documentElement.style.setProperty('--c-accent',c.accent);
  document.documentElement.style.setProperty('--c-primary',c.primary);
  $('back-btn').style.display='';$('hdr-sep').style.display='';
  $('hdr-club').textContent=c.short;$('hdr-club').style.display='';
  showV('club');renderClub();
}

function viewClubNews(cid,returnView){
  enterClub(cid, returnView?{view:returnView}:null);
  switchTab('news');
}
async function enterMd(id){
  mdId=id;mdReturnTo=null;expPlayer=null;spOpen=true;lpOpen=true;
  if(dbConnected){ await loadMatchdayDataFromDB(clubId, id); }
  showV('matchday');renderMd();reqNotifPerm();
}

async function goToLiveMatch(cid,mid){
  clubId=cid;mdId=mid;mdReturnTo={view:'home'};activeTab='matchdays';expPlayer=null;spOpen=true;lpOpen=true;
  const c=getClub(cid);if(!c)return;
  if(dbConnected){
    await loadClubDataFromDB(cid);
    await loadStandingsFromDB(cid);
    await loadMatchdayDataFromDB(cid,mid);
  }
  document.documentElement.style.setProperty('--c-accent',c.accent);
  document.documentElement.style.setProperty('--c-primary',c.primary);
  $('back-btn').style.display='';$('hdr-sep').style.display='';
  $('hdr-club').textContent=c.short;$('hdr-club').style.display='';
  showV('matchday');renderMd();reqNotifPerm();
}

async function navigateToMatch(cid,mid,returnCtx){
  clubId=cid;mdId=mid;mdReturnTo=returnCtx||null;activeTab='matchdays';expPlayer=null;spOpen=true;lpOpen=true;
  const c=getClub(cid);if(!c)return;
  if(dbConnected){
    await loadClubDataFromDB(cid);
    await loadStandingsFromDB(cid);
    await loadMatchdayDataFromDB(cid,mid);
  }
  document.documentElement.style.setProperty('--c-accent',c.accent);
  document.documentElement.style.setProperty('--c-primary',c.primary);
  $('back-btn').style.display='';$('hdr-sep').style.display='';
  $('hdr-club').textContent=c.short;$('hdr-club').style.display='';
  showV('matchday');renderMd();reqNotifPerm();
}
async function viewMdFromLogsHub(cid,mid,hubTab){
  await navigateToMatch(cid,mid,{view:'logshub',tab:hubTab||'fixtures'});
}
function currentViewId(){
  const v=document.querySelector('.view.active');
  return v?v.id:'view-home';
}
function pinnedBarReturnCtx(){
  const id=currentViewId();
  if(id==='view-logshub') return {view:'logshub',tab:logsHubTab};
  if(id==='view-newshub') return {view:'newshub'};
  if(id==='view-gallery') return {view:'gallery'};
  if(id==='view-leaderboard') return {view:'leaderboard'};
  return {view:'home'};
}
async function tapPinnedBar(cid,mid){
  await navigateToMatch(cid,mid,pinnedBarReturnCtx());
}
function openLogsView(){showV('logs');renderLogs();}

function handleAdminClick(){
  if(isAdmin){showConfirm('Logout','Log out of admin mode?','Yes, Logout',function(){isAdmin=false;currentAdmin=null;clearSession();updAB();refreshView();});}
  else openModal('m-admin');
}
async function doAdminLogin(){
  const uname=($('ap-username')||{}).value?.trim()||'';
  const pass=($('ap')||{}).value?.trim()||'';
  if(!uname||!pass){$('ap-err').textContent='Enter your username and password.';$('ap-err').style.display='';return;}
  if(!dbConnected){$('ap-err').textContent='Cannot reach the server right now. Check your connection and try again.';$('ap-err').style.display='';return;}

  try{
    const found = await dbLoginAdmin(uname,pass);
    found.managedClub=found.managed_club;
    isAdmin=true;currentAdmin=found;cm('m-admin');
    if($('ap'))$('ap').value='';if($('ap-username'))$('ap-username').value='';
    $('ap-err').style.display='none';
    updAB();refreshView();
    writeLog('admin_login','admin',{details:{name:found.name,role:found.role}});
    showToast('Welcome '+found.name,'Logged in as '+(found.role||'Admin'));
  }catch(e){
    $('ap-err').textContent=e.message||'Incorrect username or password.';$('ap-err').style.display='';
  }
}
async function doCreateAdmin(){
  if(!isOwner()){if($('ca-err')){$('ca-err').textContent='Only the Platform Owner can create admin profiles.';$('ca-err').style.display='';}return;}
  const username=($('ca-username')||{}).value?.trim()||'';
  const password=($('ca-password')||{}).value?.trim()||'';
  const name=($('ca-name')||{}).value?.trim()||'';
  const role=($('ca-role')||{}).value||'Club Admin';
  const managedClub=($('ca-club')||{}).value||'all';
  if(!username||!password||!name){if($('ca-err')){$('ca-err').textContent='All fields required.';$('ca-err').style.display='';}return;}
  if(password.length<6){if($('ca-err')){$('ca-err').textContent='Password must be at least 6 characters.';$('ca-err').style.display='';}return;}
  var newAdmin={username,password,name,role,managedClub};
  try{
    await dbCreateAdmin(newAdmin);
    cm('m-create-admin');
    showToast('Admin Created',name+' can now log in.');
    writeLog('admin_created','admin',{details:{name,role}});
    renderAdminProfiles();
  }catch(e){
    if($('ca-err')){$('ca-err').textContent=e.message||'Could not create admin.';$('ca-err').style.display='';}
  }
}
async function doDeleteAdmin(userId,username){
  showConfirm('Remove Admin','Remove admin "'+username+'"?','Yes, Remove',async function(){
    try{
      await dbDeleteAdmin(userId);
      showToast('Admin Removed',username+' removed.');renderAdminProfiles();
    }catch(e){
      showToast('Error','Could not remove admin: '+(e.message||''));
    }
  });
}
async function renderAdminProfiles(){
  var admins=dbConnected?await dbGetAdmins():[];
  var el=$('admin-profiles-list');if(!el)return;
  if(!admins.length){el.innerHTML='<div style="color:#999;font-style:italic;font-size:13px">No admin profiles yet.</div>';return;}
  el.innerHTML=admins.map(function(a){
    var clubName=a.managed_club==='all'?'All Clubs':(getClub(a.managed_club)||{}).short||a.managed_club;
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 13px;background:#f8f9fc;border-radius:9px;border:1.5px solid #e0e4ef;margin-bottom:7px">'+
      '<div style="width:38px;height:38px;border-radius:50%;background:#1d2d5a;color:#4dc8c8;display:flex;align-items:center;justify-content:center;font-family:Oswald,sans-serif;font-size:15px;font-weight:700;flex-shrink:0">'+a.name.split(' ').map(function(w){return w[0]}).join('').slice(0,2).toUpperCase()+'</div>'+
      '<div style="flex:1"><div style="font-weight:700;font-size:14px;color:#1a1a2e">'+a.name+'</div>'+
      '<div style="font-size:11px;color:#999">@'+a.username+' - '+a.role+' - '+clubName+'</div></div>'+
      '<button onclick="doDeleteAdmin(\''+a.user_id+'\',\''+a.username+'\')" style="background:none;border:none;color:#e74c3c;font-size:18px;cursor:pointer;padding:3px">x</button></div>';
  }).join('');
}
function openCreateAdmin(){
  if(!isAdmin||!currentAdmin||currentAdmin.role!=='Platform Owner'){showToast('Access Denied','Only the Platform Owner can manage admin profiles.');return;}
  $('ca-username').value='';$('ca-password').value='';$('ca-name').value='';
  if($('ca-err'))$('ca-err').style.display='none';
  openModal('m-create-admin');
  setTimeout(renderAdminProfiles,50);
}
function updAB(){
  var b=$('admin-btn');
  b.classList.toggle('on',isAdmin);
  b.title=isAdmin?(currentAdmin?currentAdmin.name+' — tap to logout':'Admin'):'Admin Login';
  var icon=$('admin-btn-icon');
  if(icon){
    if(isAdmin){
      icon.setAttribute('stroke','currentColor');
      icon.innerHTML='<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><polyline points="16 11 18 13 22 9" stroke-width="2"/>';
    } else {
      icon.innerHTML='<circle cx="12" cy="8" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>';
    }
  }
  var mgr=$('manage-admins-btn');
  if(mgr) mgr.style.display=(isAdmin&&currentAdmin&&currentAdmin.role==='Platform Owner')?'':'none';
  var galAdminBtn=$('gal-add-btn-wrap');
  if(galAdminBtn) galAdminBtn.style.display=isAdmin?'':'none';
}
function refreshView(){const v=document.querySelector('.view.active');if(!v)return;if(v.id==='view-home')renderHome();else if(v.id==='view-club')renderClub();else if(v.id==='view-matchday')renderMd();else if(v.id==='view-logs')renderLogs();}

const GOAL_SVG='⚽';
const ASSIST_SVG='🎯';
function goalIconFor(club){return GOAL_SVG;}
// Last word of a full name — used so scoreboards read "Modungwa" instead
// of the full "Letlhogonolo Vincent Modungwa".
function lastNameOf(fullName){
  if(!fullName) return '';
  const parts=fullName.trim().split(/\s+/);
  return parts[parts.length-1];
}
// Groups a scorers array (goals or assists) by player, so a player with
// multiple goals shows once with every minute attached — e.g.
// "Modungwa '10 '11 '12" — instead of their name repeated on separate lines.
// Same grouping as formatScorersList, but returns structured objects
// ({name, minutes}) instead of a joined string — for UIs that render one
// chip/element per player rather than one combined line of text.
function groupEvtsForChips(arr){
  if(!arr||!arr.length) return [];
  const order=[],map={};
  arr.forEach(g=>{
    const k=g.pid||g.name;
    if(!map[k]){ map[k]={name:g.name,minutes:[]}; order.push(k); }
    if(g.minute) map[k].minutes.push(g.minute);
  });
  return order.map(k=>map[k]);
}
function formatScorersList(arr){
  if(!arr||!arr.length) return '';
  const order=[],map={};
  arr.forEach(g=>{
    const k=g.pid||g.name;
    if(!map[k]){ map[k]={name:g.name,minutes:[]}; order.push(k); }
    if(g.minute) map[k].minutes.push(g.minute);
  });
  return order.map(k=>{
    const grp=map[k];
    const mins=grp.minutes.map(m=>"'"+m).join(' ');
    return lastNameOf(grp.name)+(mins?' '+mins:'');
  }).join(', ');
}
function liveGoalScorersH(club,md,wrapClass){
  const sc=scorers[club.id+'_'+md.id];
  if(!sc||!sc.goals||!sc.goals.length)return'';
  const icon=goalIconFor(club);
  const names=formatScorersList(sc.goals);
  return`<div class="${wrapClass}">${icon} ${names}</div>`;
}
function renderHome(){
  renderBrandLogo();
  const heroLogos=$('hero-logos');
  heroLogos.innerHTML=ucLogo?`<img class="hero-uc-logo" src="${ucLogo}" alt="UC Sports"/>`
    :clubs.map(c=>`<img class="hero-logo" src="${logoSrc(c)}" alt="${c.name}"/>`).join('');
  const liveSection=$('live-section'),liveList=$('live-matches-list');
  const liveMds=[];
  clubs.forEach(c=>{(getData(c.id)?.matchdays||[]).filter(m=>m.status==='live').forEach(m=>{liveMds.push({club:c,md:m})})});
  if(liveMds.length){
    liveSection.style.display='';
    liveList.innerHTML=liveMds.map(({club,md})=>{
      const info=getLiveClockInfo(md);
      const timeStr=!info.running?'LIVE':(info.paused?'HT':info.timeStr);
      const halfStr=info.running?info.halfLabel:'Not started';
      const scorersH=liveGoalScorersH(club,md,'live-row-scorers');
      return`<div class="live-match-row" onclick="goToLiveMatch('${club.id}','${md.id}')">
        ${logoH(club,36)}
        <div class="live-timer" data-cid="${club.id}" data-mid="${md.id}">${timeStr}</div>
        <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:14px;color:#1a1a2e">${club.short} vs ${md.opponent}</div><div style="font-size:11px;color:#999">${halfStr}${md.venue?` &middot; &#128205; ${md.venue}`:''}</div>${scorersH}</div>
        <div class="live-score">${md.homeGoals||0} - ${md.awayGoals||0}</div>
        ${liveBadgeH(md)}
      </div>`;
    }).join('');
  } else liveSection.style.display='none';
  // Show/hide admin gallery upload button
  var galAdminBtn = document.getElementById('gal-add-btn-wrap');
  if(galAdminBtn) galAdminBtn.style.display = isAdmin ? '' : 'none';

  var strip = $('home-gallery-strip');
  var preview = $('home-gallery-preview');
  if(strip && preview && gallery.length > 0){
    strip.style.display = '';
    var recent = gallery.slice(0,4);
    var previewHTML = '';
    recent.forEach(function(item,i){
      var club = item.clubId ? getClub(item.clubId) : null;
      var overlay = (i===3&&gallery.length>4) ? '<div style="position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;color:#fff;font-family:Oswald,sans-serif;font-size:20px;font-weight:700">+' + (gallery.length-4) + '</div>' : '';
      var badge = club ? '<div style="position:absolute;bottom:5px;left:5px;padding:1px 6px;border-radius:6px;font-size:9px;font-weight:800;background:' + club.primary + ';color:' + club.accent + '">' + club.short + '</div>' : '';
      previewHTML += '<div onclick="openGalleryView()" style="position:relative;aspect-ratio:1;min-width:0;overflow:hidden;cursor:pointer;background:#f0f0f5"><img src="' + item.img + '" alt="' + item.title + '" style="width:100%;height:100%;object-fit:cover"/>' + overlay + badge + '</div>';
    });
    preview.innerHTML = previewHTML;
  } else if(strip){
    strip.style.display = 'none';
  }

  var newsStrip = $('home-news-strip');
  var newsPreview = $('home-news-preview');
  if(newsStrip && newsPreview){
    var allNews = [];
    clubs.forEach(function(c){
      (getData(c.id)?.headlines||[]).forEach(function(h){ allNews.push(Object.assign({},h,{clubId:c.id})); });
    });
    allNews.sort(function(a,b){
      var av=a.created_at?new Date(a.created_at).getTime():0;
      var bv=b.created_at?new Date(b.created_at).getTime():0;
      return bv-av;
    });
    if(allNews.length){
      newsStrip.style.display='';
      newsPreview.innerHTML = allNews.slice(0,4).map(function(h){
        var club = getClub(h.clubId);
        return '<div data-cid="'+h.clubId+'" data-hid="'+h.id+'" onclick="openNewsDetail(this.dataset.cid,this.dataset.hid)" style="display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid var(--border);border-radius:10px;padding:10px 13px;margin-bottom:8px;cursor:pointer">'
          + '<img src="'+logoSrc(club)+'" style="width:30px;height:30px;object-fit:contain;border-radius:7px;flex-shrink:0"/>'
          + '<div style="flex:1;min-width:0"><div style="font-family:Oswald,sans-serif;font-size:14px;font-weight:700;color:#1a1a2e">'+h.title+'</div>'
          + '<div style="font-size:11px;color:#999"><span style="color:'+club.accent+';font-weight:700">'+club.short+'</span>'+(h.date?' &middot; '+h.date:'')+'</div></div>'
          + '</div>';
      }).join('');
    } else {
      newsStrip.style.display='none';
    }
  }
  applyHomeStripVisibility();

  // Show Live tile if any match is live
  var anyLive = false;
  clubs.forEach(function(cl){ (getData(cl.id)||{matchdays:[]}).matchdays.forEach(function(m){ if(m.status==='live') anyLive=true; }); });
  var liveTile = $('home-tile-live');
  if(liveTile) liveTile.style.display = anyLive ? '' : 'none';

  $('clubs-grid').innerHTML=clubs.map(clubCardH).join('');
}
function clubCardH(club){
  const data=getData(club.id),players=data?.players||[],headlines=data?.headlines||[];
  const liveMds=(data?.matchdays||[]).filter(m=>m.status==='live');
  const sorted=[...players].sort((a,b)=>overallRating(club.id,b.id)-overallRating(club.id,a.id));
  const newsH=headlines.slice(0,2).map(h=>`<div class="news-item" style="border-color:${club.accent};cursor:pointer" onclick="openNewsDetail('${club.id}',${h.id})">${h.title}</div>`).join('');
  let lbH='',anyR=false;
  sorted.slice(0,5).forEach((p,i)=>{const r=overallRating(club.id,p.id);if(!r)return;anyR=true;
    lbH+=`<div class="lb-row" style="${i===0?`background:${club.primary}12`:''};cursor:pointer" onclick="openPlayerInfo('${p.id}','${club.id}')">`+
      `<span class="lb-rank">${['&#127945;','&#129352;','&#129353;','4.','5.'][i]}</span>`+
      avH(p.name,p.img,28,club.primary,club.accent)+
      `<div style="flex:1;min-width:0"><div class="lb-name">${p.name}</div><div class="lb-pos">${p.pos}</div></div>`+
      `<div>${starsH(r,10)}</div></div>`;
  });
  if(!anyR)lbH='<div class="no-lb">Rate players after matchdays!</div>';
  return`<div class="club-card">
    <div class="cc-head" style="background:${club.primary};border-bottom-color:${club.accent}">${logoH(club,58)}
      <div><div class="cc-name">${club.name}</div><div class="cc-sport" style="color:${club.accent}">${club.sport}</div><div class="cc-tag">${club.tagline}</div></div>
    </div>
    ${liveMds.length?`<div class="cc-live-row">${liveMds.map(m=>{
      const info=getLiveClockInfo(m);
      const halfTag=(info.running&&!info.paused)?` &middot; ${info.halfLabel}`:'';
      return`<div class="cc-live-item"><span class="live-badge${isMatchPaused(m)?' paused-badge':''}" style="cursor:pointer" onclick="goToLiveMatch('${club.id}','${m.id}')">${isMatchPaused(m)?'<span class="pause-icon">&#10074;&#10074;</span>'+pausedBreakLabel(m):'<span class="live-dot"></span>LIVE'} vs ${m.opponent}${halfTag} &middot; ${m.homeGoals||0}-${m.awayGoals||0}</span>${liveGoalScorersH(club,m,'cc-live-scorers')}</div>`;
    }).join('')}</div>`:''}
    ${headlines.length?`<div class="cc-news"><div class="sec-lbl" style="color:${club.accent}">Latest News</div>${newsH}</div>`:''}
    <div class="cc-lb"><div class="sec-lbl" style="color:${club.accent}">Leaderboard</div>${lbH}</div>
    <div class="cc-foot">
      ${isAdmin?`<button onclick="openUcLogoModal()" style="width:100%;padding:7px;border-radius:8px;border:1.5px dashed #ddd;background:transparent;font-size:12px;color:#999;cursor:pointer;margin-bottom:6px">&#127941; Edit UC Main Logo</button>`:''}
      ${isAdmin?`<button onclick="openLogsView()" style="width:100%;padding:7px;border-radius:8px;border:1.5px dashed #ddd;background:transparent;font-size:12px;color:#999;cursor:pointer;margin-bottom:6px">&#128203; View Activity Logs</button>`:''}
      <button onclick="openStandings('${club.id}')" style="width:100%;padding:8px;border-radius:8px;border:1.5px solid ${club.accent};background:transparent;font-size:12px;color:${club.accent};cursor:pointer;margin-bottom:7px;font-weight:700">Standings Table</button>
      <button class="enter-btn" style="background:${club.primary};border-color:${club.accent};color:${club.accent}" 
        onmouseover="this.style.background='${club.accent}';this.style.color='#fff'"
        onmouseout="this.style.background='${club.primary}';this.style.color='${club.accent}'"
        onclick="enterClub('${club.id}')">Enter ${club.short} &#8594;</button>
    </div>
  </div>`;
}

function renderClub(){
  const club=getClub(clubId),data=getData(clubId);if(!club||!data)return;
  $('club-banner').innerHTML=`<div style="background:${club.primary};border-radius:16px;padding:20px 24px;display:flex;align-items:center;gap:18px;border-bottom:4px solid ${club.accent};position:relative">
    ${logoH(club,76)}<div style="flex:1"><h2>${club.name}</h2><div class="ban-meta" style="color:${club.accent}">${club.sport} &middot; ${data.players.length} Players</div><div class="ban-tag">${club.tagline}</div>${clubDescriptions[clubId]?`<div style="font-size:12.5px;color:rgba(255,255,255,.75);margin-top:6px;line-height:1.5;max-width:520px">${clubDescriptions[clubId]}</div>`:''}</div>
    ${isAdmin?`<button id="edit-club-btn" onclick="openEditClub()">&#9999; Edit Club</button>`:''}
  </div>`;

  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  const activePanel=$('tab-'+activeTab);if(activePanel)activePanel.classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>{const t=b.textContent.toLowerCase(),on=t===activeTab;b.classList.toggle('on',on);b.style.borderColor=on?club.accent:'';b.style.background=on?club.accent:'';b.style.color=on?'#fff':'';});
  renderTabAct();renderTabContent();
}
function switchTab(tab){
  activeTab=tab;document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));$('tab-'+tab).classList.add('active');
  const club=getClub(clubId);document.querySelectorAll('.tab-btn').forEach(b=>{const on=b.textContent.toLowerCase()===tab;b.classList.toggle('on',on);b.style.borderColor=on?club?.accent:'';b.style.background=on?club?.accent:'';b.style.color=on?'#fff':'';});
  renderTabAct();renderTabContent();
}
function renderTabAct(){
  const club=getClub(clubId),data=getData(clubId);let h='';
  if(isAdmin){
    if(activeTab==='players'&&(data?.players||[]).length<30)h=`<button class="tact-btn" style="border-color:#2ecc71;color:#2ecc71" onclick="openAddPlayer()">+ Add Player</button>`;
    else if(activeTab==='staff')h=`<button class="tact-btn" style="border-color:${club.accent};color:${club.accent}" onclick="openAddStaff()">+ Add Staff</button>`;
    else if(activeTab==='matchdays')h=`<button class="tact-btn" style="border-color:${club.accent};color:${club.accent}" onclick="openAddMd()">+ Add Matchday</button>`;
    else if(activeTab==='news')h=`<button class="tact-btn" style="border-color:#e74c3c;color:#e74c3c" onclick="openAddNews()">+ Add Headline</button>`;
  }
  $('tab-act').innerHTML=h;
}
function renderTabContent(){if(activeTab==='players')renderPlayers();if(activeTab==='staff')renderStaff();if(activeTab==='matchdays')renderMatchdays();if(activeTab==='news')renderNews();}

function renderPlayers(){
  const club=getClub(clubId),data=getData(clubId),players=data?.players||[];
  if(!players.length){$('players-grid').innerHTML=`<div class="empty-msg">No players yet.</div>`;return;}
  $('players-grid').innerHTML=players.map(p=>pcH(p,club)).join('');
}
function pcH(p,club){
  const r=overallRating(clubId,p.id),hasR=r>0;
  // Build avatar: if player has a photo, the img itself is tappable to view fullscreen.
  // The wrapper div has no click so the card click (openPlayerInfo) fires normally.
  const imgTag=p.img
    ?`<img src="${p.img}" alt="${p.name}" onclick="event.stopPropagation();openPhotoViewer('${p.img.replace(/'/g,"\\'")}','${p.name.replace(/'/g,"\\'")}','${club.accent}')" style="width:100%;height:100%;object-fit:cover;border-radius:50%;cursor:zoom-in"/>`
    :``;
  const ini=p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const fs=Math.round(66*.33);
  const avatarHTML=`<div class="av" style="width:66px;height:66px;border-color:${club.accent};background:${club.primary};color:${club.accent};font-family:'Oswald',sans-serif;font-size:${fs}px;font-weight:700">${imgTag||(p.img?'':ini)}</div>`;
  return`<div class="pc ${hasR?'rated':''}" id="pc_${p.id}" onclick="openPlayerInfo('${p.id}')">
    <div class="pc-head" style="background:${club.primary}">
      <div style="position:relative">${avatarHTML}
        ${isAdmin?`<button class="pc-cam-btn" style="background:${club.accent}" onclick="event.stopPropagation();openPp('${p.id}')">&#128247;</button>`:''}
      </div>
      <div class="pc-name">${p.name}</div>
      <div class="pc-meta" style="color:${club.accent}">#${p.num} &middot; ${p.pos}</div>
      ${starsH(r,15)}<div class="pc-rv" style="color:${hasR?'#e8a020':'rgba(255,255,255,.4)'}">${hasR?r.toFixed(1)+' Fan Rating':'Not yet rated'}</div>
      ${!isNetball(clubId)&&((p.yellowCards||0)+(p.redCards||0)>0)?'<div style="display:flex;gap:5px;margin-top:3px;justify-content:center">'+(p.yellowCards?'<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;color:#f1c40f;font-weight:700"><span style="display:inline-block;width:8px;height:11px;background:#f1c40f;border-radius:1px"></span>'+p.yellowCards+'</span>':'')+(p.redCards?'<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;color:#e74c3c;font-weight:700"><span style="display:inline-block;width:8px;height:11px;background:#e74c3c;border-radius:1px"></span>'+p.redCards+'</span>':'')+'</div>':''}
    </div>
    ${statsGridH(p,clubId)}
    ${isAdmin?`<div class="pc-actions">
      <button class="pc-ab" style="border-color:${club.accent};color:${club.accent}" onclick="event.stopPropagation();openEditStats('${p.id}')">Stats</button>
      <button class="pc-ab" style="border-color:#e74c3c;color:#e74c3c;flex:0;padding:6px 10px" onclick="event.stopPropagation();delPlayer('${p.id}')">&#128465;</button>
    </div>`:''}
  </div>`;
}
function delPlayer(pid){
  if(!requireOwner('Removing a player'))return;
  const p=getData(clubId)?.players?.find(pl=>pl.id===pid);
  showConfirm('Remove Player',`Remove ${p?.name||'this player'} from the squad?`,'Yes, Remove',async()=>{
    if(dbConnected){ await dbDeletePlayer(pid); }
    clubData[clubId].players=clubData[clubId].players.filter(pl=>pl.id!==pid);
    sv('uc_data_v7',clubData);renderPlayers();renderTabAct();
    writeLog('player_deleted','player',{details:{name:p?.name}});
    showToast('Player Removed',`${p?.name||'Player'} removed.`);
  });
}


let editingStaffId=null, staffNewPhoto, staffNewPhotoFile;
function renderStaff(){
  const club=getClub(clubId),list=techTeams[clubId]||[];
  if(!list.length){$('staff-grid').innerHTML=`<div class="empty-msg">No technical team members added yet.</div>`;return;}
  $('staff-grid').innerHTML=list.map(s=>staffCardH(s,club)).join('');
}
function staffCardH(s,club){
  const ini=(s.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const imgTag=s.photo
    ?`<img src="${s.photo}" alt="${s.name}" onclick="event.stopPropagation();openPhotoViewer('${s.photo.replace(/'/g,"\\'")}','${s.name.replace(/'/g,"\\'")}','${club.accent}')" style="width:100%;height:100%;object-fit:cover;border-radius:50%;cursor:zoom-in"/>`
    :``;
  return`<div class="pc" id="stf_${s.id}" onclick="openStaffProfile('${s.id}')" style="cursor:pointer">
    <div class="pc-head" style="background:${club.primary}">
      <div class="av" style="width:66px;height:66px;border-color:${club.accent};background:${club.primary};color:${club.accent};font-family:'Oswald',sans-serif;font-size:22px;font-weight:700">${imgTag||ini}</div>
      <div class="pc-name">${s.name}</div>
      <div class="pc-meta" style="color:${club.accent}">${s.role||'Staff'}</div>
    </div>
    ${isAdmin?`<div class="pc-actions">
      <button class="pc-ab" style="border-color:${club.accent};color:${club.accent};flex:1" onclick="event.stopPropagation();openEditStaff('${s.id}')">&#9998; Edit</button>
      <button class="pc-ab" style="border-color:#e74c3c;color:#e74c3c;flex:1" onclick="event.stopPropagation();delStaff('${s.id}')">&#128465; Remove</button>
    </div>`:''}
  </div>`;
}
// Fan-facing staff profile — shows photo, role, and background details
// (qualification, years of experience, bio), same idea as the player
// profile modal.
function openStaffProfile(sid){
  const club=getClub(clubId);
  const s=(techTeams[clubId]||[]).find(x=>x.id===sid);if(!s)return;
  const ini=(s.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  $('sp-modal-title').textContent=s.role||'Staff Profile';
  $('sp-header-block').style.background=club.primary;
  const avatarHTML=s.photo
    ?`<div class="av" style="width:80px;height:80px;border-color:${club.accent};background:${club.primary};flex-shrink:0"><img src="${s.photo}" alt="${s.name}" onclick="openPhotoViewer('${s.photo.replace(/'/g,"\\'")}','${s.name.replace(/'/g,"\\'")}','${club.accent}')" style="width:100%;height:100%;object-fit:cover;border-radius:50%;cursor:zoom-in"/></div>`
    :`<div class="av" style="width:80px;height:80px;border-color:${club.accent};background:${club.primary};color:${club.accent};font-family:'Oswald',sans-serif;font-size:26px;font-weight:700;flex-shrink:0">${ini}</div>`;
  $('sp-header-block').innerHTML=`${avatarHTML}
    <div><div style="font-family:'Oswald',sans-serif;font-size:20px;color:#fff">${s.name}</div>
      <div style="font-size:13px;font-weight:700;color:${club.accent};margin:3px 0">${s.role||'Staff'}</div>
      ${s.qualification?`<div style="font-size:12px;color:rgba(255,255,255,.6)">${s.qualification}</div>`:''}
    </div>`;
  let dH='';
  if(s.yearsExp!=null)dH+=`<div class="pi-field"><div class="pi-field-lbl">Experience</div><div style="font-size:14px;color:#333">${s.yearsExp} year${s.yearsExp===1?'':'s'}</div></div>`;
  dH+=`<div class="pi-field"><div class="pi-field-lbl">Background</div><div style="font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap">${s.bio&&s.bio.trim()?s.bio:'No background details added yet.'}</div></div>`;
  $('sp-details-block').innerHTML=dH;
  openModal('m-staff-profile');
}
function openAddStaff(){
  editingStaffId=null;staffNewPhoto=undefined;staffNewPhotoFile=undefined;
  $('ns-modal-title').textContent='Add Staff Member';$('ns-save-btn').textContent='Add Staff';
  $('ns-name').value='';$('ns-role').value='';$('ns-qual').value='';$('ns-years').value='';$('ns-bio').value='';
  $('ns-pre-wrap').innerHTML=`<div class="pp-pre-av">?</div>`;$('rm-ns-btn').style.display='none';
  openModal('m-add-staff');
}
function openEditStaff(sid){
  const s=(techTeams[clubId]||[]).find(x=>x.id===sid);if(!s)return;
  editingStaffId=sid;staffNewPhoto=undefined;staffNewPhotoFile=undefined;
  $('ns-modal-title').textContent='Edit Staff Member';$('ns-save-btn').textContent='Save Changes';
  $('ns-name').value=s.name;$('ns-role').value=s.role||'';
  $('ns-qual').value=s.qualification||'';$('ns-years').value=s.yearsExp||'';$('ns-bio').value=s.bio||'';
  const ini=(s.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  $('ns-pre-wrap').innerHTML=s.photo?`<img class="pp-pre" src="${s.photo}"/>`:`<div class="pp-pre-av">${ini}</div>`;
  $('rm-ns-btn').style.display=s.photo?'':'none';
  openModal('m-add-staff');
}
function onStaffPhotoUpload(e){
  const file=e.target.files[0];if(!file)return;
  staffNewPhotoFile=file;
  const r=new FileReader();
  r.onload=ev=>{
    staffNewPhoto=ev.target.result;
    $('ns-pre-wrap').innerHTML=`<img class="pp-pre" src="${staffNewPhoto}"/>`;
    $('rm-ns-btn').style.display='';
  };
  r.readAsDataURL(file);
}
function rmStaffPhoto(){
  staffNewPhoto=null;staffNewPhotoFile=undefined;
  $('ns-pre-wrap').innerHTML=`<div class="pp-pre-av">?</div>`;
  $('rm-ns-btn').style.display='none';
}
async function doSaveStaff(){
  const name=$('ns-name').value.trim(),role=$('ns-role').value.trim();
  const qualification=$('ns-qual').value.trim(),yearsExp=$('ns-years').value?parseInt($('ns-years').value):null,bio=$('ns-bio').value.trim();
  if(!name)return;
  if(!techTeams[clubId])techTeams[clubId]=[];
  if(editingStaffId){
    const s=techTeams[clubId].find(x=>x.id===editingStaffId);
    if(s){
      s.name=name;s.role=role;s.qualification=qualification;s.yearsExp=yearsExp;s.bio=bio;
      if(staffNewPhoto!==undefined){
        if(staffNewPhoto===null){ s.photo=null; }
        else if(staffNewPhotoFile){
          try{ s.photo = await uploadImageToStorage(staffNewPhotoFile, 'staff'); }
          catch(e){ showToast('Photo Upload Failed', e.message||'Could not upload photo.'); }
        }
      }
    }
    writeLog('staff_updated','staff',{details:{name,role}});
  } else {
    let photo=null;
    if(staffNewPhotoFile){
      try{ photo = await uploadImageToStorage(staffNewPhotoFile, 'staff'); }
      catch(e){ showToast('Photo Upload Failed', e.message||'Could not upload photo — staff member saved without one.'); }
    }
    techTeams[clubId].push({id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),name,role,photo,qualification,yearsExp,bio});
    writeLog('staff_added','staff',{details:{name,role}});
  }
  sv('uc_techteam_v7',techTeams);
  if(dbConnected){ await saveTechTeamToDB(clubId); }
  cm('m-add-staff');renderStaff();renderTechTeamPanel(getClub(clubId));
  showToast(editingStaffId?'Staff Updated':'Staff Added',`${name} saved to the technical team.`);
}
async function delStaff(id){
  showConfirm('Remove Staff Member','Remove this person from the technical team?','Yes, Remove',async()=>{
    const list=techTeams[clubId]||[];
    const s=list.find(x=>x.id===id);
    techTeams[clubId]=list.filter(x=>x.id!==id);
    sv('uc_techteam_v7',techTeams);
    if(dbConnected){ await saveTechTeamToDB(clubId); }
    writeLog('staff_removed','staff',{details:{name:s?.name}});
    renderStaff();renderTechTeamPanel(getClub(clubId));
    showToast('Staff Removed',`${s?.name||'Staff member'} removed.`);
  });
}

function renderTechTeamPanel(club){
  const panel=$('techteam-md-panel');if(!panel)return;
  const list=techTeams[club.id]||[];
  if(!list.length){panel.innerHTML='';return;}
  panel.innerHTML=`<div class="panel">
    <div class="panel-hdr" style="cursor:default">
      <div class="panel-title" style="color:${club.accent}">Technical Team</div>
    </div>
    <div class="panel-body" style="display:flex;flex-wrap:wrap;gap:10px">
      ${list.map(s=>{
        const ini=(s.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
        const avatar=s.photo
          ?`<img src="${s.photo}" alt="${s.name}" onclick="openPhotoViewer('${s.photo.replace(/'/g,"\\'")}','${s.name.replace(/'/g,"\\'")}','${club.accent}')" style="width:30px;height:30px;border-radius:50%;object-fit:cover;cursor:zoom-in;flex-shrink:0"/>`
          :`<div style="width:30px;height:30px;border-radius:50%;background:${club.primary};color:${club.accent};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${ini}</div>`;
        return `<div style="display:flex;align-items:center;gap:8px;background:#fafafa;border:1.5px solid var(--border);border-radius:10px;padding:6px 12px 6px 6px">
        ${avatar}
        <div>
          <div style="font-family:'Oswald',sans-serif;font-weight:700;color:#1a1a2e;font-size:13px;line-height:1.2">${s.name}</div>
          <div style="font-size:11px;color:#999">${s.role||'Staff'}</div>
        </div>
      </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderMatchdays(){
  const club=getClub(clubId),data=getData(clubId);
  // Sort by the number embedded in the label (e.g. "Matchday 1" < "Matchday 2"),
  // falling back to insertion order for labels with no number.
  const mds=[...(data?.matchdays||[])].sort(function(a,b){
    var na=parseInt((a.label||'').replace(/\D+/g,''))||0;
    var nb=parseInt((b.label||'').replace(/\D+/g,''))||0;
    return na-nb;
  });
  if(!mds.length){$('matchdays-grid').innerHTML=`<div class="empty-msg">No matchdays yet.</div>`;return;}
  $('matchdays-grid').innerHTML=mds.map(md=>{
    const{fg,bg}=rcol(md.result),key=clubId+'_'+md.id,sc=scorers[key]||{goals:[],assists:[]};
    const isLive=md.status==='live',open=isRatingOpen(md),dur=getDuration(md);
    let sprev='';
    if(sc.goals?.length)sprev+=`<div>${GOAL_SVG}<span>${formatScorersList(sc.goals)}</span></div>`;
    if(sc.assists?.length)sprev+=`<div>${ASSIST_SVG}<span>${formatScorersList(sc.assists)}</span></div>`;
    const liveScore=isLive?`<div style="display:flex;align-items:center;gap:8px;margin:6px 0;background:#fff8f8;border-radius:8px;padding:7px 12px;border:1.5px solid rgba(231,76,60,.2)">
      <span style="font-family:'Oswald',sans-serif;font-size:24px;font-weight:700;color:#1a1a2e">${md.homeGoals||0}</span>
      <span style="font-size:12px;color:#ccc;font-weight:700">-</span>
      <span style="font-family:'Oswald',sans-serif;font-size:24px;font-weight:700;color:#1a1a2e">${md.awayGoals||0}</span>
      ${liveBadgeH(md,"margin-left:6px")}
    </div>`:'';
    return`<div class="md-card${isLive?' live-card':''}" onmouseenter="this.style.borderColor='${isLive?'#e74c3c':club.accent}'" onmouseleave="this.style.borderColor=''" onclick="enterMd('${md.id}')">
      <div class="md-lbl" style="color:${isLive?(isMatchPaused(md)?'#f39c12':'#e74c3c'):club.accent}">${isLive?liveBadgeH(md):md.label}</div>
      <div class="md-vs">vs ${md.opponent}</div>
      ${md.venue?`<div class="md-info-row">&#128205; ${md.venue}</div>`:''}
      ${md.date?`<div class="md-info-row">&#128197; ${fmtKickoff(md)} &middot; ${dur.label}</div>`:''}
      ${liveScore}
      ${!isLive&&md.result?`<span class="res-badge" style="color:${fg};background:${bg};border-color:${fg}40">${md.result}</span>`:''}
      ${sprev?`<div class="md-scorer-prev">${sprev}</div>`:''}
      ${!open&&md.status!=='live'?`<div style="font-size:11px;color:#bbb;margin-top:5px;font-style:italic">${md.status==='finished'?'Ratings closed':'Ratings open at kick-off'}</div>`:''}
      <div class="md-tap" style="color:${isLive?'#e74c3c':club.accent}">Tap to view${open?' and rate':''} &#8594;</div>
      ${isAdmin?`<div onclick="event.stopPropagation()" style="display:flex;gap:6px;margin-top:8px">
        <button class="md-rmv" onclick="openEditMd('${md.id}')">Edit</button>
        <button class="md-rmv" onclick="delMd('${md.id}')">Remove</button>
      </div>`:''}
    </div>`;
  }).join('');
}
function delMd(mid){
  if(!requireOwner('Deleting a matchday'))return;
  showConfirm('Delete Matchday','Remove this matchday and all its data?','Yes, Delete',async()=>{
    if(dbConnected){ await dbDeleteMatchday(mid); }
    const players=getData(clubId)?.players||[];
    players.forEach(p=>{delete ratings[clubId+'_'+mid+'_'+p.id];delete comments[clubId+'_'+mid+'_'+p.id];});
    delete scorers[clubId+'_'+mid];delete lineups[clubId+'_'+mid];
    clubData[clubId].matchdays=clubData[clubId].matchdays.filter(m=>m.id!==mid);
    sv('uc_data_v7',clubData);sv('uc_ratings_v7',ratings);sv('uc_cmts_v7',comments);sv('uc_scorers_v7',scorers);sv('uc_lineups_v7',lineups);
    writeLog('matchday_deleted','matchday',{matchday_id:mid});
    renderMatchdays();showToast('Matchday Deleted','Matchday removed.');
  });
}

function renderNews(){
  const data=getData(clubId),headlines=data?.headlines||[];
  if(!headlines.length){$('news-list').innerHTML=`<div style="color:#ccc;font-style:italic;padding:20px 0">No news yet.</div>`;return;}
  $('news-list').innerHTML=headlines.map(h=>`<div class="news-row" style="cursor:pointer" onclick="openNewsDetail('${clubId}',${h.id})">
    <div><div class="nr-title">${h.title}</div><div class="nr-date">${h.date}</div></div>
    ${isAdmin?`<button class="nr-del" onclick="event.stopPropagation();openEditNews(${h.id})" style="margin-right:4px">&#9998;</button><button class="nr-del" onclick="event.stopPropagation();delNews(${h.id})">x</button>`:''}
  </div>`).join('');
}
async function delNews(hid){
  if(!requireOwner('Deleting a headline'))return;
  showConfirm('Delete Headline','Remove this news headline?','Yes, Delete',async ()=>{
    if(dbConnected){ await dbDeleteHeadline(hid); }
    clubData[clubId].headlines=clubData[clubId].headlines.filter(h=>h.id!=hid);
    sv('uc_data_v7',clubData);renderNews();
  });
}

function renderMd(){
  const club=getClub(clubId),data=getData(clubId),md=data?.matchdays?.find(m=>m.id===mdId);
  if(!club||!data||!md)return;
  const{fg,bg}=rcol(md.result),isLive=md.status==='live',open=isRatingOpen(md);
  const dur=getDuration(md),homeG=md.homeGoals||0,awayG=md.awayGoals||0;
  const sc=scorers[clubId+'_'+md.id]||{goals:[],assists:[]};
  $('md-banner').innerHTML=`<div style="background:${club.primary};border-radius:16px;padding:18px 22px;border-bottom:4px solid ${club.accent}">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:14px">
        ${logoH(club,50)}<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            ${isLive?liveBadgeH(md):`<span style="font-size:10px;color:${club.accent};font-weight:800;letter-spacing:1.5px;text-transform:uppercase">${md.label}</span>`}
          </div>
          <div style="font-family:'Oswald',sans-serif;font-size:22px;color:#fff;margin-bottom:2px">vs ${md.opponent}</div>
          ${md.venue?`<div style="font-size:12px;color:rgba(255,255,255,.5)">&#128205; ${md.venue}</div>`:''}
          ${md.date?`<div style="font-size:12px;color:rgba(255,255,255,.4)">&#128197; ${fmtKickoff(md)} &middot; ${dur.label}</div>`:''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
        ${isLive||md.status==='finished'?`
          <div style="display:flex;align-items:center;background:rgba(0,0,0,.3);border-radius:12px;overflow:hidden;border:1px solid ${isLive?'#e74c3c':'rgba(255,255,255,.1)'}">
            <div style="padding:10px 20px;text-align:center;border-right:1px solid rgba(255,255,255,.1)">
              <div style="font-size:9px;font-weight:800;color:${club.accent};text-transform:uppercase;margin-bottom:2px">${club.short.split(' ')[0]}</div>
              <div style="font-family:'Oswald',sans-serif;font-size:32px;font-weight:700;color:#fff;line-height:1">${homeG}</div>
            </div>
            <div style="padding:10px 12px;text-align:center">
              <div style="font-size:10px;color:${isLive&&isMatchPaused(md)?'#f39c12':'#aaa'};font-weight:700">${isLive?(isMatchPaused(md)?'HT':'LIVE'):'FT'}</div>
              <div style="font-family:'Oswald',sans-serif;font-size:14px;color:#555;margin-top:2px">-</div>
            </div>
            <div style="padding:10px 20px;text-align:center;border-left:1px solid rgba(255,255,255,.1)">
              <div style="font-size:9px;font-weight:800;color:#aaa;text-transform:uppercase;margin-bottom:2px">${md.opponent.split(' ')[0]}</div>
              <div style="font-family:'Oswald',sans-serif;font-size:32px;font-weight:700;color:#fff;line-height:1">${awayG}</div>
            </div>
          </div>
          ${md.result?`<div style="padding:3px 12px;border-radius:6px;font-family:'Oswald',sans-serif;font-size:13px;font-weight:600;color:${fg};background:${bg};border:1.5px solid ${fg}40;margin-top:2px">${md.result}</div>`:''}
        `:`${md.result?`<div style="padding:5px 16px;border-radius:8px;font-family:'Oswald',sans-serif;font-size:20px;font-weight:600;color:${fg};background:${bg};border:1.5px solid ${fg}40">${md.result}</div>`:`<div style="font-size:13px;color:rgba(255,255,255,.4)">Not started</div>`}`}
        ${isAdmin?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
          <button onclick="openManageMatch()" style="background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:7px;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px">
            <svg style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Manage Match
          </button>
        </div>`:''}
      </div>
    </div>
    ${isLive&&sc.goals?.length?`<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:7px;flex-wrap:wrap">
      ${groupEvtsForChips(sc.goals).map(g=>`<span style="font-size:11px;background:rgba(255,255,255,.08);border-radius:6px;padding:3px 8px;color:#ddd">${GOAL_SVG} ${lastNameOf(g.name)}${g.minutes.map(m=>"'"+m).join(' ')?' '+g.minutes.map(m=>"'"+m).join(' '):''}</span>`).join('')}
      ${groupEvtsForChips(sc.assists||[]).map(a=>`<span style="font-size:11px;background:rgba(255,255,255,.08);border-radius:6px;padding:3px 8px;color:#bbb">${ASSIST_SVG} ${lastNameOf(a.name)}${a.minutes.map(m=>"'"+m).join(' ')?' '+a.minutes.map(m=>"'"+m).join(' '):''}</span>`).join('')}
    </div>`:''}
  </div>`;
  // Rating status bar
  const bar=$('rating-status-bar'),now=Date.now(),openMs=ratingOpenMs(md),closeMs=ratingCloseMs(md);
  bar.style.display='';
  if(md.forceOpen){
    bar.style.cssText='display:;border-color:#2ecc71;background:#f0faf4;color:#2ecc71;padding:11px 14px;border-radius:8px;border:1.5px solid;font-size:13px;font-weight:700;';
    bar.innerHTML=`Ratings OPEN (reopened by admin)${isAdmin?`<button onclick="closeRatingsOverride('${mdId}')" style="margin-left:10px;padding:3px 10px;border-radius:6px;border:1.5px solid #2ecc71;background:#fff;font-size:11px;cursor:pointer;color:#2ecc71">Close Now</button>`:''}`;
  } else if(md.forceClose||md.status==='finished'){
    bar.style.cssText='display:;border-color:#ddd;background:#f9f9f9;color:#999;padding:11px 14px;border-radius:8px;border:1.5px solid;font-size:13px;font-weight:700;';
    bar.innerHTML=`Ratings closed${md.forceClose?' (force-closed)':' (window ended)'}${isAdmin?`<button onclick="reopenRatings('${mdId}')" style="margin-left:10px;padding:3px 10px;border-radius:6px;border:1.5px solid #ddd;background:#fff;font-size:11px;cursor:pointer;color:#888">Reopen</button>`:''}`;
  } else if(open){
    const pct=closeMs?Math.max(0,Math.min(100,((now-openMs)/(closeMs-openMs))*100)):0;
    bar.style.cssText=`display:;border-color:#2ecc71;background:#f0faf4;color:#2ecc71;padding:11px 14px;border-radius:8px;border:1.5px solid;font-size:13px;font-weight:700;`;
    bar.innerHTML=`Ratings OPEN - ${isLive?'Match is live! ':''}${ratingClosesIn(md)}<div style="margin-top:6px;background:#e0f5e9;border-radius:4px;height:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:#2ecc71;border-radius:4px;transition:width .5s"></div></div>${isAdmin?`<button onclick="closeRatingsOverride('${mdId}')" style="margin-left:8px;padding:3px 10px;border-radius:6px;border:1.5px solid #2ecc71;background:#fff;font-size:11px;cursor:pointer;color:#2ecc71">Close Now</button>`:''}`;
  } else {
    bar.style.cssText=`display:;border-color:${club.accent};background:#fafcff;color:${club.accent};padding:11px 14px;border-radius:8px;border:1.5px solid;font-size:13px;font-weight:700;`;
    bar.innerHTML=`Ratings open ${ratingOpensIn(md)||'at kick-off'}${openMs?`<span style="font-weight:400;color:#999"> - ${new Date(openMs).toLocaleString()}</span>`:''}${isAdmin?`<button onclick="openEditMd('${mdId}')" style="margin-left:8px;padding:3px 10px;border-radius:6px;border:1.5px solid ${club.accent};background:#fff;font-size:11px;cursor:pointer;color:${club.accent}">Open now</button>`:''}`;
  }
  // Prominent scorers strip for live matches
  renderLiveScorerStrip(club, sc, isLive);
  $('md-hint').style.display=open?'':'none';
  if(isLive)startTimer(md);else stopTimer();
  renderScorers(club,data,md);
  renderLineup(club,data,md);
  renderTechTeamPanel(club);
  renderMdPlayers(club,data,md);
}

function evtIconSvg(type){
  if(type==='goal') return '<span style="font-size:15px;line-height:1">⚽</span>';
  if(type==='assist') return '<span style="font-size:15px;line-height:1">🎯</span>';
  if(type==='yellow') return '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2" fill="#f1c40f"/></svg>';
  if(type==='red') return '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2" fill="#e74c3c"/></svg>';
  return '';
}
function renderScorers(club,data,md){
  const key=clubId+'_'+md.id,sc=scorers[key]||{goals:[],assists:[],cards:[]},players=data.players||[];
  const isNB=isNetball(clubId);
  const goalLabel=isNB?'Goals':'Goals',assistLabel=isNB?'Assists':'Assists';

  // Groups repeated entries for the same player (e.g. a hat-trick) into a
  // single row with one minute chip per goal, instead of repeating their
  // name on a separate line for every goal.
  function groupEvtsByPlayer(arr){
    const order=[],map={};
    arr.forEach((item,i)=>{
      const k=item.pid||item.name;
      if(!map[k]){ map[k]={name:item.name,entries:[]}; order.push(k); }
      map[k].entries.push({minute:item.minute,idx:i});
    });
    return order.map(k=>map[k]);
  }
  function evtGroupRow(group,type){
    const arrKey=type==='goal'?'goals':'assists';
    const chips=group.entries.map(e=>
      `<span class="se-min-chip">${e.minute?"'"+e.minute:''}${isAdmin?`<button class="se-min-del" onclick="delScorer('${key}','${arrKey}',${e.idx})">&times;</button>`:''}</span>`
    ).join('');
    return `<div class="se"><span class="se-icon">${evtIconSvg(type)}</span><span class="se-name">${group.name}</span><span class="se-min-list">${chips}</span></div>`;
  }
  function evtRow(item,type,i){
    return `<div class="se"><span class="se-icon">${evtIconSvg(type)}</span><span class="se-name">${item.name}</span><span class="se-min">${item.minute?"'"+item.minute:''}</span>${isAdmin?`<button class="se-del" onclick="delScorer('${key}','${type==='goal'?'goals':type==='assist'?'assists':'cards'}',${i})">&times;</button>`:''}</div>`;
  }

  const gGroups=groupEvtsByPlayer(sc.goals||[]);
  const aGroups=groupEvtsByPlayer(sc.assists||[]);
  const gH=gGroups.length?gGroups.map(g=>evtGroupRow(g,'goal')).join(''):`<div class="no-se">No goals yet</div>`;
  const aH=aGroups.length?aGroups.map(g=>evtGroupRow(g,'assist')).join(''):`<div class="no-se">No assists yet</div>`;
  const cardsArr=sc.cards||[];
  const cH=cardsArr.length?cardsArr.map((cd,i)=>evtRow(cd,cd.type,i)).join(''):`<div class="no-se">No cards yet</div>`;

  const opts=players.map(p=>`<option value="${p.id}">${p.name} (#${p.num})</option>`).join('');

  // Auto-fill the minute from the live match clock whenever the match is
  // actually live — admins no longer need to type it in themselves. If the
  // match isn't live (e.g. adding a retroactive event to a finished match),
  // the field stays a normal editable number input.
  const liveMin=getCurrentMatchMinute(md);
  const minuteFieldH=liveMin!=null
    ? `<input id="sc-m" type="number" value="${liveMin}" readonly class="finp" style="width:68px;flex:none;background:#f5f5f5;color:#888" title="Auto-filled from the live match clock"/>`
    : `<input id="sc-m" type="number" min="1" max="130" placeholder="Min" class="finp" style="width:68px;flex:none"/>`;

  $('scorers-panel').innerHTML=`<div class="panel">
    <div class="panel-hdr" onclick="spOpen=!spOpen;renderScorers(getClub(clubId),getData(clubId),getData(clubId).matchdays.find(m=>m.id===mdId))">
      <div class="panel-title" style="color:${club.accent};display:flex;align-items:center;gap:7px">
        <svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/></svg>
        Match Events
      </div>
      <span class="panel-toggle">${spOpen?'Hide':'Show'}</span>
    </div>
    <div class="panel-body" style="display:${spOpen?'block':'none'}">
      <div class="sp-cols" style="grid-template-columns:1fr 1fr 1fr">
        <div class="sp-col"><div class="sp-col-t" style="color:${club.accent}">${goalLabel}</div>${gH}</div>
        <div class="sp-col"><div class="sp-col-t" style="color:${club.highlight||'#e8457a'}">${assistLabel}</div>${aH}</div>
        <div class="sp-col"><div class="sp-col-t" style="color:#f1c40f">Cards</div>${cH}</div>
      </div>
      ${isAdmin?`<div class="evt-add-wrap">
        <div class="evt-type-row" id="evt-type-row">
          <button type="button" class="evt-type-btn active" data-type="goal" onclick="setEvtType(this)"><span class="evt-type-icon">${evtIconSvg('goal')}</span>Goal</button>
          <button type="button" class="evt-type-btn" data-type="assist" onclick="setEvtType(this)"><span class="evt-type-icon">${evtIconSvg('assist')}</span>Assist</button>
          <button type="button" class="evt-type-btn" data-type="yellow" onclick="setEvtType(this)"><span class="evt-type-icon">${evtIconSvg('yellow')}</span>Yellow</button>
          <button type="button" class="evt-type-btn" data-type="red" onclick="setEvtType(this)"><span class="evt-type-icon">${evtIconSvg('red')}</span>Red</button>
        </div>
        <div class="sp-add">
          <select id="sc-p" style="flex:2"><option value="">Select Player</option>${opts}</select>
          ${minuteFieldH}
          <button class="sp-add-btn" style="border-color:${club.accent};color:${club.accent}" onclick="addScorer('${key}')">Add Event</button>
        </div>
      </div>`:''}
    </div>
  </div>`;
}
function setEvtType(btn){
  document.querySelectorAll('.evt-type-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
}
async function addScorer(key){
  const activeBtn=document.querySelector('.evt-type-btn.active');
  const type=activeBtn?activeBtn.dataset.type:'goal';
  const pid=$('sc-p').value;
  if(!pid){showToast('Select a player','Choose who this event is for.');return;}
  const player=getData(clubId).players.find(p=>p.id===pid);
  const p2=clubData[clubId].players.find(p=>p.id===pid);
  if(!scorers[key])scorers[key]={goals:[],assists:[],cards:[]};
  if(!scorers[key].cards)scorers[key].cards=[];
  const md=clubData[clubId].matchdays.find(function(m){return m.id===mdId;});
  const liveMin=md?getCurrentMatchMinute(md):null;
  const min=liveMin!=null?liveMin:($('sc-m').value||'');

  if(type==='goal'){
    scorers[key].goals.push({pid,name:player.name,minute:min||''});
    if(p2) p2.goals=(p2.goals||0)+1;
    if(md){ md.homeGoals=(md.homeGoals||0)+1; }
  } else if(type==='assist'){
    scorers[key].assists.push({pid,name:player.name,minute:min||''});
    if(p2) p2.assists=(p2.assists||0)+1;
  } else if(type==='yellow'){
    scorers[key].cards.push({pid,name:player.name,minute:min||'',type:'yellow'});
    if(p2) p2.yellowCards=(p2.yellowCards||0)+1;
  } else if(type==='red'){
    scorers[key].cards.push({pid,name:player.name,minute:min||'',type:'red'});
    if(p2) p2.redCards=(p2.redCards||0)+1;
  }

  if(dbConnected){
    try{
      await dbSaveScorers(clubId,mdId,scorers[key]);
    }catch(e){
      try{ await new Promise(r=>setTimeout(r,1200)); await dbSaveScorers(clubId,mdId,scorers[key]); }
      catch(e2){ showToast('Not Saved',"This event didn't reach the server. Check your connection — it may need to be re-entered."); }
    }
    if(p2) await dbSavePlayer(pid,p2);
    if(type==='goal' && md){ await dbSaveMatchday(clubId,{...md,_dbId:md._dbId||md.id}); }
  }
  sv('uc_scorers_v7',scorers);sv('uc_data_v7',clubData);
  writeLog(type+'_added','scorer',{player_id:pid,details:{minute:min}});
  $('sc-m').value='';
  renderLiveScorerStrip(getClub(clubId),scorers[key],md&&md.status==='live');
  renderScorers(getClub(clubId),getData(clubId),md);
  renderLineup(getClub(clubId),getData(clubId),md);
  renderMd(); // refresh score banner
}
async function delScorer(key,type,idx){
  if(!scorers[key])return;
  const rm=scorers[key][type].splice(idx,1)[0];
  const md=clubData[clubId].matchdays.find(function(m){return m.id===mdId;});
  if(rm&&rm.pid){
    const p2=clubData[clubId].players.find(pl=>pl.id===rm.pid);
    if(p2){
      if(type==='goals'){ p2.goals=Math.max(0,(p2.goals||0)-1); if(md) md.homeGoals=Math.max(0,(md.homeGoals||0)-1); }
      else if(type==='assists'){ p2.assists=Math.max(0,(p2.assists||0)-1); }
      else if(type==='cards'){
        if(rm.type==='yellow') p2.yellowCards=Math.max(0,(p2.yellowCards||0)-1);
        else if(rm.type==='red') p2.redCards=Math.max(0,(p2.redCards||0)-1);
      }
      if(dbConnected){ await dbSavePlayer(rm.pid,p2); }
    }
  }
  if(dbConnected){
    try{
      await dbSaveScorers(clubId,mdId,scorers[key]);
    }catch(e){
      try{ await new Promise(r=>setTimeout(r,1200)); await dbSaveScorers(clubId,mdId,scorers[key]); }
      catch(e2){ showToast('Not Saved',"This change didn't reach the server. Check your connection and try again."); }
    }
    if(type==='goals' && md){ await dbSaveMatchday(clubId,{...md,_dbId:md._dbId||md.id}); }
  }
  sv('uc_scorers_v7',scorers);sv('uc_data_v7',clubData);
  var md2r2=md;
  renderLiveScorerStrip(getClub(clubId),scorers[key],md2r2&&md2r2.status==='live');
  renderScorers(getClub(clubId),getData(clubId),md2r2);
  renderLineup(getClub(clubId),getData(clubId),md2r2);
  if(type==='goals') renderMd();
}


const PITCH_W=340,PITCH_H=500;
function buildPitchSVG(isNB){
  const w=PITCH_W,h=PITCH_H;
  if(isNB){
    const stripes=Array.from({length:10},(_,i)=>`<rect x="0" y="${i*(h/10)}" width="${w}" height="${h/10}" fill="${i%2===0?'#4a1a6b':'#521e75'}"/>`).join('');
    return`<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="pitch-svg-bg" style="border-radius:12px">
      ${stripes}
      <rect x="14" y="14" width="${w-28}" height="${h-28}" rx="5" fill="none" stroke="#ffffff25" stroke-width="1.5"/>
      <circle cx="${w/2}" cy="${h/2}" r="44" fill="none" stroke="#ffffff20" stroke-width="1"/>
      <circle cx="${w/2}" cy="${h/2}" r="3" fill="#ffffff30"/>
      <line x1="14" y1="${h/3}" x2="${w-14}" y2="${h/3}" stroke="#ffffff20" stroke-width="1"/>
      <line x1="14" y1="${h*2/3}" x2="${w-14}" y2="${h*2/3}" stroke="#ffffff20" stroke-width="1"/>
      <circle cx="${w/2}" cy="44" r="36" fill="none" stroke="#ffffff18" stroke-width="1"/>
      <circle cx="${w/2}" cy="${h-44}" r="36" fill="none" stroke="#ffffff18" stroke-width="1"/>
      <rect x="${w/2-16}" y="10" width="32" height="20" rx="3" fill="none" stroke="#ffffff28" stroke-width="1.5"/>
      <rect x="${w/2-16}" y="${h-30}" width="32" height="20" rx="3" fill="none" stroke="#ffffff28" stroke-width="1.5"/>
    </svg>`;
  }
  const stripes=Array.from({length:10},(_,i)=>`<rect x="0" y="${i*(h/10)}" width="${w}" height="${h/10}" fill="${i%2===0?'#1a4a1a':'#1e521e'}"/>`).join('');
  return`<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="pitch-svg-bg" style="border-radius:12px">
    ${stripes}
    <rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="none" stroke="#ffffff15" stroke-width="1.5"/>
    <rect x="14" y="14" width="${w-28}" height="${h-28}" rx="5" fill="none" stroke="#ffffff20" stroke-width="1.5"/>
    <line x1="14" y1="${h/2}" x2="${w-14}" y2="${h/2}" stroke="#ffffff18" stroke-width="1"/>
    <circle cx="${w/2}" cy="${h/2}" r="44" fill="none" stroke="#ffffff18" stroke-width="1"/>
    <circle cx="${w/2}" cy="${h/2}" r="3" fill="#ffffff25"/>
    <rect x="${w*.2}" y="14" width="${w*.6}" height="${h*.17}" rx="2" fill="none" stroke="#ffffff14" stroke-width="1"/>
    <rect x="${w*.2}" y="${h*.83}" width="${w*.6}" height="${h*.17}" rx="2" fill="none" stroke="#ffffff14" stroke-width="1"/>
  </svg>`;
}
function renderLineup(club,data,md){
  const key=clubId+'_'+md.id;
  const formList=Object.keys(FORMATIONS[club.sport]||{});
  if(!lineups[key]) lineups[key]={formation:formList[0]||'',slots:{},subs:[]};
  else if(!lineups[key].formation) lineups[key].formation=formList[0]||'';
  const lu=lineups[key];
  const rows=FORMATIONS[club.sport]?.[lu.formation]||[];
  const players=data.players||[];
  const sc=scorers[key]||{goals:[],assists:[]};
  const isNB=isNetball(clubId);
  const N=rows.length;
  function rowY(ri){if(N===1)return 85;return 88-((ri/(N-1))*(88-8));}
  function rowX(ci,count){
    if(count===1)return 50;if(count===2)return ci===0?32:68;
    if(count===3)return[22,50,78][ci];if(count===4)return[14,38,62,86][ci];
    if(count===5)return[10,28,50,72,90][ci];return 10+(ci*(80/(count-1)));
  }
  let tokens='';
  rows.forEach((rowSlots,ri)=>{
    const y=rowY(ri),count=rowSlots.length;
    rowSlots.forEach((posLabel,ci)=>{
      const x=rowX(ci,count),slotKey=ri+'_'+ci,pid=lu.slots[slotKey]||'';
      const player=pid?players.find(p=>p.id===pid):null;
      const goals=(sc.goals||[]).filter(g=>g.pid===pid).length;
      const assists=(sc.assists||[]).filter(a=>a.pid===pid).length;
      const yellows=(sc.cards||[]).filter(c=>c.pid===pid&&c.type==='yellow').length;
      const reds=(sc.cards||[]).filter(c=>c.pid===pid&&c.type==='red').length;
      let events='';
      for(let g=0;g<Math.min(goals,3);g++) events+='⚽';
      if(assists) for(let a=0;a<Math.min(assists,2);a++) events+='🎯';
      if(yellows) for(let y=0;y<Math.min(yellows,2);y++) events+='🟨';
      if(reds) events+='🟥';
      const pRating=pid?mdRating(clubId,md.id,pid):0;
      const pRatingStars=pid&&pRating>0?Array.from({length:5},(_,i)=>`<span class="pp-star ${i<Math.round(pRating)?'on':'off'}">&#9733;</span>`).join(''):'';
      const subObj=(lu.subs||[]).find(s=>(typeof s==='object'?s.out:s)===pid);
      const subbedOff=!!subObj;
      const subInPlayer=subObj?(players.find(p=>p.id===(typeof subObj==='object'?subObj.in:''))||null):null;
      const subMinute=subObj&&typeof subObj==='object'?subObj.minute:'';
      if(player){
        const ini=player.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
        const lastName=player.name.split(' ').slice(-1)[0];
        const borderCol=subbedOff?'#e74c3c':club.accent,bgCol=subbedOff?'rgba(80,10,10,.85)':club.primary;
        tokens+=`<div class="pp-token" style="left:${x}%;top:${y}%;cursor:pointer" onclick="openPlayerInfo('${pid}')">
          <div style="position:relative">
            <div class="pp-circle" style="border-color:${borderCol};background:${bgCol};color:${subbedOff?'#e74c3c':club.accent};${subbedOff?'opacity:0.7':''}">
              ${player.img?`<img src="${player.img}" alt="${player.name}"/>`:ini}
            </div>
            ${subbedOff?`<div class="sub-indicator" style="background:#e74c3c">v</div>`:''}
          </div>
          <div class="pp-lastname" style="${subbedOff?'color:#e74c3c;text-decoration:line-through':''}">${lastName}</div>
          ${subbedOff&&subInPlayer?`<div class="pp-lastname" style="color:#2ecc71">^ ${subInPlayer.name.split(' ').slice(-1)[0]}${subMinute?" '"+subMinute:''}</div>`:''}
          ${events?`<div class="pp-events">${events}</div>`:''}
          ${pRatingStars?`<div class="pp-stars">${pRatingStars}</div>`:''}
        </div>`;
      } else {
        tokens+=`<div class="pp-token" style="left:${x}%;top:${y}%"><div class="pp-circle empty-slot" style="border-color:${club.accent}55;color:${club.accent}55;font-size:9px;font-family:'DM Sans',sans-serif;font-weight:700">${posLabel}</div></div>`;
      }
    });
  });
  const subObjs=(lu.subs||[]).filter(s=>(typeof s==='object'?s.in:s));
  const benchH=subObjs.length?`<div class="bench-strip"><div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#f39c12;margin-right:6px;align-self:center;flex-shrink:0">SUBS</div>
    ${subObjs.map(sub=>{
      const inPid=typeof sub==='object'?sub.in:sub,outPid=typeof sub==='object'?sub.out:'',minute=typeof sub==='object'?sub.minute:'';
      const pIn=players.find(pl=>pl.id===inPid);if(!pIn)return'';
      const pOut=players.find(pl=>pl.id===outPid),r=mdRating(clubId,md.id,inPid);
      return`<div class="bench-player"><div style="display:flex;flex-direction:column;align-items:center;gap:1px">${avH(pIn.name,pIn.img,32,club.primary,club.accent)}<div style="font-size:9px;font-weight:800;color:#2ecc71">IN</div></div>
        <div><div class="bench-name">${pIn.name.split(' ').slice(-1)[0]} <span style="color:#bbb;font-weight:400">#${pIn.num}</span></div>
        ${pOut?`<div style="font-size:10px;color:#e74c3c">OUT ${pOut.name.split(' ').slice(-1)[0]} #${pOut.num}</div>`:''}
        ${minute?`<div style="font-size:10px;color:#999">${minute}'</div>`:''}
        ${r>0?`<div class="bench-r">${starsH(r,9)} ${r.toFixed(1)}</div>`:''}
        </div></div>`;
    }).join('')}
  </div>`:'';
  let slotsH='';
  if(isAdmin){
    let slotRows='';
    rows.forEach((rowSlots,ri)=>{rowSlots.forEach((posLabel,ci)=>{
      const slotKey=ri+'_'+ci,pid=lu.slots[slotKey]||'';
      const opts=`<option value="">None</option>`+players.map(p=>`<option value="${p.id}" ${p.id===pid?'selected':''}>${p.name} (#${p.num})</option>`).join('');
      slotRows+=`<div class="slot-row"><span class="slot-lbl">${posLabel}</span><select class="slot-sel" data-slot="${slotKey}">${opts}</select></div>`;
    });});
    let subsRows=(lu.subs||[]).map((sub,i)=>{
      const inPid=typeof sub==='object'?sub.in:'',outPid=typeof sub==='object'?sub.out:'',minute=typeof sub==='object'?sub.minute:'';
      const starterOpts=`<option value="">Starter Off</option>`+Object.values(lu.slots||{}).filter(Boolean).map(pid=>{const p=players.find(pl=>pl.id===pid);return p?`<option value="${p.id}" ${p.id===outPid?'selected':''}>${p.name} #${p.num}</option>`:''}).join('');
      const allOpts=`<option value="">Sub On</option>`+players.map(p=>`<option value="${p.id}" ${p.id===inPid?'selected':''}>${p.name} (#${p.num})</option>`).join('');
      return`<div class="sub-editor-row"><select class="sub-out-sel" data-sub="${i}">${starterOpts}</select><span class="sub-arrow-mid">swap</span><select class="sub-in-sel" data-sub="${i}">${allOpts}</select><input class="sub-min-inp" type="number" min="1" max="130" placeholder="Min" value="${minute}"/><button onclick="delSub('${key}',${i})" style="background:none;border:none;color:#e74c3c;font-size:16px;cursor:pointer;padding:0">x</button></div>`;
    }).join('');
    slotsH=`<div class="form-ctrl"><label style="font-size:10px;color:#999;font-weight:700;text-transform:uppercase;letter-spacing:.8px">${isNB?'Formation:':'Formation:'}</label>
      <select class="form-sel" id="lp-form" onchange="changeFormation(this.value,'${key}')">
        ${formList.map(f=>`<option value="${f}" ${f===lu.formation?'selected':''}>${f}</option>`).join('')}
      </select></div>
    <div class="slots-list" id="slots-list">${slotRows}</div>
    <div class="subs-list"><div class="subs-title">Substitutes</div><div id="subs-rows">${subsRows}</div>
      ${(lu.subs||[]).length<9?`<button onclick="addSubSlot('${key}')" style="border-color:#f39c12;color:#f39c12;background:#fff;border:1.5px solid;border-radius:7px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;margin-top:4px">+ Add Sub</button>`:''}
    </div>
    <button class="save-lineup-btn" style="border-color:${club.accent};color:${club.accent};margin-top:12px" onclick="saveLineup('${key}')">Save ${isNB?'Court':'Lineup'}</button>`;
  } else {
    slotsH=lu.formation?`<div style="font-size:12px;color:#888;padding:4px 0">Formation: <strong style="color:${club.accent}">${lu.formation}</strong></div>`:'';
  }
  $('lineup-panel').innerHTML=`<div class="panel">
    <div class="panel-hdr" onclick="lpOpen=!lpOpen;renderLineup(getClub(clubId),getData(clubId),getData(clubId).matchdays.find(m=>m.id===mdId))">
      <div class="panel-title" style="color:${club.accent}">${isNB?'Court and Formation':'Lineup and Formation'}</div>
      <span class="panel-toggle">${lpOpen?'Hide':'Show'}</span>
    </div>
    <div style="display:${lpOpen?'block':'none'}">
      <div class="panel-body">
        <div class="pitch-container">${buildPitchSVG(isNB)}<div class="pitch-overlay">${tokens}</div></div>
        ${benchH}${slotsH}
      </div>
    </div>
  </div>`;
}
function changeFormation(val,key){if(!lineups[key])lineups[key]={formation:val,slots:{},subs:[]};lineups[key].formation=val;lineups[key].slots={};sv('uc_lineups_v7',lineups);renderLineup(getClub(clubId),getData(clubId),getData(clubId).matchdays.find(m=>m.id===mdId));}
function addSubSlot(key){if(!lineups[key])lineups[key]={formation:'',slots:{},subs:[]};lineups[key].subs.push({in:'',out:'',minute:''});sv('uc_lineups_v7',lineups);renderLineup(getClub(clubId),getData(clubId),getData(clubId).matchdays.find(m=>m.id===mdId));}
function delSub(key,idx){if(!lineups[key])return;lineups[key].subs.splice(idx,1);sv('uc_lineups_v7',lineups);renderLineup(getClub(clubId),getData(clubId),getData(clubId).matchdays.find(m=>m.id===mdId));}
async function saveLineup(key){
  const lu=lineups[key]||{formation:'',slots:{},subs:[]};
  const formSel=$('lp-form');
  if(formSel&&formSel.value) lu.formation=formSel.value;
  document.querySelectorAll('.slot-sel').forEach(s=>{lu.slots[s.dataset.slot]=s.value;});
  const subInEls=document.querySelectorAll('.sub-in-sel'),subOutEls=document.querySelectorAll('.sub-out-sel'),subMinEls=document.querySelectorAll('.sub-min-inp');
  lu.subs=[];subInEls.forEach((el,i)=>{lu.subs.push({in:el.value,out:subOutEls[i]?.value||'',minute:subMinEls[i]?.value||''});});
  lineups[key]=lu;
  let saveOk=true;
  if(dbConnected){
    try{
      await dbSaveLineup(clubId,mdId,lu);
    }catch(e){
      try{ await new Promise(r=>setTimeout(r,1200)); await dbSaveLineup(clubId,mdId,lu); }
      catch(e2){ saveOk=false; }
    }
  }
  sv('uc_lineups_v7',lineups);
  const md=getData(clubId).matchdays.find(m=>m.id===mdId),club=getClub(clubId);
  renderLineup(club,getData(clubId),md);
  writeLog('lineup_saved','lineup',{matchday_id:mdId,details:{formation:lu.formation}});
  if(saveOk){
    showToast('Lineup Saved',`${club.short} lineup updated!`);
    sendNotif('Lineup Updated',`${club.short} lineup posted for vs ${md.opponent}.`);
  } else {
    showToast('Not Saved',"The lineup didn't reach the server. Check your connection and tap Save again.");
  }
}


function getSubPids(lu){return(lu.subs||[]).map(s=>typeof s==='object'?s.in:s).filter(Boolean);}
function isEligible(pid){
  const key=clubId+'_'+mdId,lu=lineups[key]||{slots:{},subs:[]};
  const all=new Set([...Object.values(lu.slots||{}).filter(Boolean),...getSubPids(lu)]);
  if(all.size===0)return true;
  return all.has(pid);
}
function renderMdPlayers(club,data,md){
  const players=data?.players||[];
  if(!players.length){$('md-players').innerHTML=`<div style="color:#ccc;text-align:center;padding:48px;font-style:italic">No players in squad yet.</div>`;return;}
  const open=isRatingOpen(md),key=clubId+'_'+md.id,lu=lineups[key]||{slots:{},subs:[]};
  const starterPids=new Set(Object.values(lu.slots||{}).filter(Boolean)),subPids=new Set(getSubPids(lu));
  const lineupEmpty=starterPids.size===0&&subPids.size===0;
  if(lineupEmpty){
    $('md-players').innerHTML=`<div style="color:#888;font-size:13px;font-style:italic;padding:10px 0 14px">No lineup posted yet - all players shown.</div>`+players.map(p=>mpH(p,club,md,open,true)).join('');
    return;
  }
  const starterList=[],subList=[],restList=[];
  const formRows=FORMATIONS[club.sport]?.[lu.formation]||[];
  formRows.forEach((row,ri)=>row.forEach((_,ci)=>{const pid=lu.slots[ri+'_'+ci]||'';if(pid){const p=players.find(pl=>pl.id===pid);if(p)starterList.push(p);}}));
  getSubPids(lu).forEach(pid=>{const p=players.find(pl=>pl.id===pid);if(p)subList.push(p);});
  players.forEach(p=>{if(!starterPids.has(p.id)&&!subPids.has(p.id))restList.push(p);});
  let html='';
  if(starterList.length){html+=`<div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${club.accent};margin:14px 0 8px">Starting ${isNetball(clubId)?'Seven':'XI'}</div>`;html+=starterList.map(p=>mpH(p,club,md,open,true)).join('');}
  if(subList.length){html+=`<div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#f39c12;margin:14px 0 8px">Substitutes</div>`;html+=subList.map(p=>mpH(p,club,md,open,true)).join('');}
  if(restList.length){html+=`<div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#bbb;margin:14px 0 8px">Not in Lineup</div>`;html+=restList.map(p=>mpH(p,club,md,open,false)).join('');}
  $('md-players').innerHTML=html;
}
function mpH(p,club,md,open,eligible=true){
  const mr=mdRating(clubId,md.id,p.id),or=overallRating(clubId,p.id),myR=myRating(clubId,md.id,p.id),exp=expPlayer===p.id,canRate=open&&eligible;
  const pcmts=(comments[clubId+'_'+md.id+'_'+p.id]||[]);
  let cmtsH='';
  if(exp&&eligible){
    const noC=!pcmts.length?`<div style="color:#ccc;font-size:13px;font-style:italic;margin-bottom:8px">No comments yet.</div>`:'';
    const cList=pcmts.map(c=>`<div class="cmt-item"><div style="flex:1"><div class="cmt-meta">Fan #${c.fanId.slice(-6)} - ${c.ts}</div><div class="cmt-text">${c.text}</div></div>${isAdmin?`<button class="cmt-del" onclick="delCmt('${p.id}','${c.id}')">x</button>`:''}</div>`).join('');
    cmtsH=`<div class="mp-cmts" id="cmts_${p.id}"><div style="padding-top:10px;margin-bottom:8px">${noC}${cList}</div>
      ${canRate?`<div class="cmt-ir"><input class="cmt-inp" id="ci_${p.id}" placeholder="Comment on ${p.name.split(' ')[0]}..." onkeydown="if(event.key==='Enter'){postCmt('${p.id}');event.preventDefault()}" style="border-color:${club.accent}"/><button class="cmt-post" style="border-color:${club.accent};color:${club.accent}" onclick="postCmt('${p.id}')">Post</button></div>`:`<div class="rating-locked-msg">${!eligible?'Not in lineup':'Rating closed'}</div>`}
    </div>`;
  }
  const dimStyle=eligible?'':'opacity:0.42;filter:grayscale(0.5)';
  return`<div class="mp ${exp&&eligible?'exp':''} ${myR>0&&eligible?'rated':''}" id="mp_${p.id}" style="${dimStyle}">
    <div class="mp-main">
      ${avH(p.name,p.img,46,club.primary,club.accent)}
      <div class="mp-info">
        <div class="mp-name">${p.name}</div>
        <div class="mp-meta">#${p.num} - ${p.pos}</div>
        ${canRate?`<div class="rate-row">${starsH(myR,21,true,clubId,md.id,p.id)}<span class="rate-lbl" style="color:${myR>0?club.accent:'#ccc'}">${myR>0?'You rated '+myR+'/5':'Tap to rate'}</span></div>`
          :eligible?`<div class="rate-row">${starsH(mr,21,false)}<span class="rate-lbl">${mr>0?mr.toFixed(1):'Locked'}</span></div>`
          :`<div class="rate-row"><span class="rate-lbl" style="color:#ccc;font-size:12px">Not in lineup</span></div>`}
        ${or>0&&eligible?`<div class="overall-row">${starsH(or,11)}<span class="overall-lbl">${or.toFixed(1)} overall</span></div>`:''}
      </div>
      ${eligible?`<button class="cmt-btn" onclick="toggleCmts('${p.id}')">Comments ${pcmts.length} ${exp?'^':'v'}</button>`:''}
    </div>${cmtsH}
  </div>`;
}
async function doRate(cid,mid,pid,stars){const md=getData(cid)?.matchdays?.find(m=>m.id===mid);if(!md||!isRatingOpen(md)||!isEligible(pid))return;await rateP(cid,mid,pid,stars);reRenderMp(pid);writeLog('player_rated','rating',{player_id:pid,matchday_id:mid,details:{stars}});renderLineup(getClub(cid),getData(cid),md);}
function reRenderMp(pid){const club=getClub(clubId),data=getData(clubId),md=data?.matchdays?.find(m=>m.id===mdId);if(!club||!data||!md)return;const p=data.players.find(pl=>pl.id===pid),el=$('mp_'+pid);if(el&&p)el.outerHTML=mpH(p,club,md,isRatingOpen(md),isEligible(pid));}
function toggleCmts(pid){expPlayer=expPlayer===pid?null:pid;const club=getClub(clubId),data=getData(clubId),md=data?.matchdays?.find(m=>m.id===mdId);const p=data.players.find(pl=>pl.id===pid),el=$('mp_'+pid);if(el&&p)el.outerHTML=mpH(p,club,md,isRatingOpen(md),isEligible(pid));}
async function postCmt(pid){const md=getData(clubId)?.matchdays?.find(m=>m.id===mdId);if(!md||!isRatingOpen(md))return;const inp=$('ci_'+pid),text=inp?.value?.trim();if(!text)return;const key=clubId+'_'+mdId+'_'+pid;if(!comments[key])comments[key]=[];let newId=Date.now().toString();if(dbConnected){const row=await dbPostComment(clubId,mdId,pid,text);if(row&&row.id)newId=row.id;}comments[key].push({id:newId,fanId,text,ts:new Date().toLocaleString()});sv('uc_cmts_v7',comments);writeLog('comment_posted','comment',{player_id:pid,matchday_id:mdId});if(inp)inp.value='';reRenderMp(pid);}
async function delCmt(pid,cid){if(dbConnected){ await dbDeleteComment(cid); }const key=clubId+'_'+mdId+'_'+pid;if(comments[key])comments[key]=comments[key].filter(c=>c.id!==cid);sv('uc_cmts_v7',comments);writeLog('comment_deleted','comment',{player_id:pid,matchday_id:mdId});reRenderMp(pid);}


const LOG_COLORS={rating:'log-rating',comment:'log-comment',matchday:'log-matchday',player:'log-player',admin:'log-admin',club:'log-club',scorer:'log-scorer',lineup:'log-lineup'};
function renderLogs(){
  const clubFilter=$('log-filter-club')?.value||'',catFilter=$('log-filter-cat')?.value||'',search=$('log-search')?.value?.toLowerCase()||'';
  let filtered=logs.filter(l=>{
    if(clubFilter&&l.club_id!==clubFilter)return false;
    if(catFilter&&l.category!==catFilter)return false;
    if(search&&!JSON.stringify(l).toLowerCase().includes(search))return false;
    return true;
  });
  const total=filtered.length,page=Math.min(logsPage,Math.max(0,Math.ceil(total/LOGS_PER_PAGE)-1));
  logsPage=page;
  const paged=filtered.slice(page*LOGS_PER_PAGE,(page+1)*LOGS_PER_PAGE);
  const tbody=$('logs-tbody');
  if(!paged.length){tbody.innerHTML=`<tr><td colspan="5" class="logs-empty">No logs found.</td></tr>`;$('logs-pagination').innerHTML='';return;}
  tbody.innerHTML=paged.map(l=>{
    const cls=LOG_COLORS[l.category]||'log-admin';
    const ts=new Date(l.ts).toLocaleString();
    const clubName=l.club_id?getClub(l.club_id)?.short||l.club_id:'N/A';
    const det=l.details&&Object.keys(l.details).length?JSON.stringify(l.details).slice(0,80):'N/A';
    return`<tr><td style="white-space:nowrap;color:#999;font-size:12px">${ts}</td><td><span class="log-action-badge ${cls}">${l.action}</span></td><td style="font-size:12px;color:#555">${clubName}</td><td style="font-size:12px;color:#888;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${det}">${det}</td><td style="font-size:11px;color:#bbb">#${l.fan_id?.slice(-6)||'N/A'}</td></tr>`;
  }).join('');
  const totalPages=Math.ceil(total/LOGS_PER_PAGE);
  if(totalPages<=1){$('logs-pagination').innerHTML='';return;}
  let pages='';
  for(let i=0;i<Math.min(totalPages,10);i++)pages+=`<button class="page-btn${i===page?' on':''}" onclick="logsPage=${i};renderLogs()">${i+1}</button>`;
  $('logs-pagination').innerHTML=`<div style="text-align:center;margin-top:12px;color:#999;font-size:13px">${total} entries - Page ${page+1} of ${totalPages}</div><div class="logs-pagination">${pages}</div>`;
}
function clearLogs(){showConfirm('Clear All Logs','Delete all activity logs?','Yes, Clear',()=>{logs=[];sv('uc_logs_v7',logs);renderLogs();showToast('Logs Cleared','All logs deleted.');});}


function openPhotoViewer(src,name,accent){
 
  var old=$('photo-viewer-overlay');if(old)old.remove();
  var ov=document.createElement('div');
  ov.id='photo-viewer-overlay';
  ov.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;animation:fadeInOv .18s ease';
  ov.innerHTML=`
    <style>@keyframes fadeInOv{from{opacity:0}to{opacity:1}}@keyframes popIn{from{transform:scale(.88);opacity:0}to{transform:scale(1);opacity:1}}</style>
    <button onclick="document.getElementById('photo-viewer-overlay').remove()" style="position:absolute;top:18px;right:18px;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:26px;width:44px;height:44px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;z-index:2">&times;</button>
    <div style="position:absolute;top:18px;left:0;right:0;text-align:center;color:#fff;font-family:'Oswald',sans-serif;font-size:16px;font-weight:600;letter-spacing:.5px;opacity:.85">${name}</div>
    <img src="${src}" alt="${name}" style="max-width:92vw;max-height:80vh;border-radius:16px;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,.7);animation:popIn .22s ease;border:3px solid ${accent||'rgba(255,255,255,.15)'}"/>
    <div style="margin-top:18px;color:rgba(255,255,255,.35);font-size:12px">Tap anywhere to close</div>
  `;
  // Tap backdrop to close
  ov.addEventListener('click',function(e){if(e.target===ov||e.target.tagName==='DIV')ov.remove();});
  document.body.appendChild(ov);
}

function openPlayerInfo(pid,cid){
  if(cid) clubId=cid;
  viewingPid=pid;piNewPhoto=undefined;piNewPhotoFile=undefined;
  const club=getClub(clubId),data=getData(clubId),p=data.players.find(pl=>pl.id===pid);if(!p)return;
  const r=overallRating(clubId,pid),isNB=isNetball(clubId);
  $('pi-modal-title').textContent=p.shirtname||p.name;
  $('pi-header-block').style.background=club.primary;
  const ini=p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const avatarHTML=p.img
    ?`<div class="av" style="width:80px;height:80px;border-color:${club.accent};background:${club.primary};flex-shrink:0"><img src="${p.img}" alt="${p.name}" onclick="openPhotoViewer('${p.img.replace(/'/g,"\\'")}','${p.name.replace(/'/g,"\\'")}','${club.accent}')" style="width:100%;height:100%;object-fit:cover;border-radius:50%;cursor:zoom-in"/></div>`
    :`<div class="av" style="width:80px;height:80px;border-color:${club.accent};background:${club.primary};color:${club.accent};font-family:'Oswald',sans-serif;font-size:26px;font-weight:700;flex-shrink:0">${ini}</div>`;
  $('pi-header-block').innerHTML=`${avatarHTML}
    <div><div style="font-family:'Oswald',sans-serif;font-size:20px;color:#fff">${p.name}</div>
      <div style="font-size:13px;font-weight:700;color:${club.accent};margin:3px 0">#${p.num} - ${p.pos}</div>
      ${p.nationality?`<div style="font-size:12px;color:rgba(255,255,255,.6)">${p.nationality}${p.hometown?' - '+p.hometown:''}</div>`:''}
      ${p.age?`<div style="font-size:12px;color:rgba(255,255,255,.6)">Age ${p.age}${p.height?' - '+p.height+' cm':''}</div>`:''}
    </div>`;
  const fields=getStatFields(clubId,p.pos),gridCls=isNB?'netball-grid':'football-grid';
  $('pi-stats-block').innerHTML=`<div class="pi-stat-grid ${gridCls}" style="grid-template-columns:repeat(${isNB?4:3},1fr)">${fields.map(f=>`<div class="pi-stat"><div class="pi-stat-num">${computeStatValue(p,f,clubId)}</div><div class="pi-stat-lbl">${f.lbl}</div></div>`).join('')}</div>`;
  let fH='';
  if(r>0)fH+=`<div class="pi-field"><div class="pi-field-lbl">Fan Rating</div><div>${starsH(r,16)} <span style="color:#e8a020;font-weight:700">${r.toFixed(1)} / 5.0</span></div></div>`;
  // All stats summary
  var allStats='';
  var gpCount=getPlayerAppearances(clubId,p.id);
  if(!isNB){
    if(p.goals)allStats+='<span style="background:#e8f5e9;color:#2ecc71;border:1px solid #a5d6a7;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.goals+' Goals</span>';
    if(p.assists)allStats+='<span style="background:#e3f2fd;color:#1976d2;border:1px solid #90caf9;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.assists+' '+ASSIST_SVG+' Assists</span>';
    if(gpCount)allStats+='<span style="background:#f3e5f5;color:#7b1fa2;border:1px solid #ce93d8;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+gpCount+' Games</span>';
    if(p.cleanSheets)allStats+='<span style="background:#e0f7fa;color:#0097a7;border:1px solid #80deea;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.cleanSheets+' CS</span>';
    if(p.yellowCards)allStats+='<span style="background:#fff8e1;color:#f57f17;border:1px solid #ffe082;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px"><span style="display:inline-block;width:9px;height:13px;background:#f1c40f;border-radius:2px;vertical-align:middle;margin-right:3px"></span>'+p.yellowCards+' YC</span>';
    if(p.redCards)allStats+='<span style="background:#fce4ec;color:#c62828;border:1px solid #ef9a9a;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px"><span style="display:inline-block;width:9px;height:13px;background:#e74c3c;border-radius:2px;vertical-align:middle;margin-right:3px"></span>'+p.redCards+' RC</span>';
  } else {
    if(p.goals)allStats+='<span style="background:#e8f5e9;color:#2ecc71;border:1px solid #a5d6a7;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.goals+' Goals</span>';
    if(p.attempts)allStats+='<span style="background:#e3f2fd;color:#1976d2;border:1px solid #90caf9;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.attempts+' Attempts</span>';
    if(p.assists)allStats+='<span style="background:#f3e5f5;color:#7b1fa2;border:1px solid #ce93d8;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.assists+' '+ASSIST_SVG+' Assists</span>';
    if(p.intercepts)allStats+='<span style="background:#fff3e0;color:#e65100;border:1px solid #ffcc80;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.intercepts+' Intercepts</span>';
    if(gpCount)allStats+='<span style="background:#fce4ec;color:#880e4f;border:1px solid #f48fb1;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+gpCount+' Games</span>';
  }
  if(allStats)fH+=`<div class="pi-field"><div class="pi-field-lbl">Stats</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:2px">${allStats}</div></div>`;
  // Personal details
  if(p.age)fH+=`<div class="pi-field"><div class="pi-field-lbl">Age</div><div class="pi-field-val">${p.age} years old</div></div>`;
  if(p.nationality)fH+=`<div class="pi-field"><div class="pi-field-lbl">Nationality</div><div class="pi-field-val">${p.nationality}</div></div>`;
  if(p.hometown)fH+=`<div class="pi-field"><div class="pi-field-lbl">Hometown</div><div class="pi-field-val">${p.hometown}</div></div>`;
  if(p.height)fH+=`<div class="pi-field"><div class="pi-field-lbl">Height</div><div class="pi-field-val">${p.height} cm</div></div>`;
  if(!isNB&&p.foot)fH+=`<div class="pi-field"><div class="pi-field-lbl">Preferred Foot</div><div class="pi-field-val">${p.foot}</div></div>`;
  if(p.bio)fH+=`<div class="pi-field"><div class="pi-field-lbl">Background</div><div class="pi-bio">${p.bio}</div></div>`;
  $('pi-fields-block').innerHTML=fH||(!isAdmin?`<div style="color:#ccc;font-style:italic;font-size:13px">No profile info yet.</div>`:'');
  $('pi-admin-btns').style.display=isAdmin?'flex':'none';
  $('pi-view').style.display='';$('pi-edit').style.display='none';
  openModal('m-player-info');
}
function switchToEditPlayer(){
  const data=getData(clubId),club=getClub(clubId),p=data.players.find(pl=>pl.id===viewingPid);if(!p)return;
  piNewPhoto=undefined;const isNB=isNetball(clubId);
  $('pi-pos').innerHTML=POSITIONS[club.sport].map(pos=>`<option value="${pos}" ${pos===p.pos?'selected':''}>${pos}</option>`).join('');
  $('pi-name').value=p.name||'';$('pi-num').value=p.num||'';$('pi-age').value=p.age||'';
  $('pi-nationality').value=p.nationality||'';$('pi-hometown').value=p.hometown||'';$('pi-height').value=p.height||'';$('pi-bio').value=p.bio||'';
  $('pi-sport-fields').innerHTML=!isNB?`<div class="edit-grid-2"><div><label class="flbl">Preferred Foot</label><select id="pi-foot" class="fsel"><option value="">N/A</option><option value="Right" ${p.foot==='Right'?'selected':''}>Right</option><option value="Left" ${p.foot==='Left'?'selected':''}>Left</option><option value="Both" ${p.foot==='Both'?'selected':''}>Both</option></select></div><div><label class="flbl">Shirt Name</label><input id="pi-shirtname" class="finp" value="${p.shirtname||''}"/></div></div>`:`<div><label class="flbl">Shirt Name</label><input id="pi-shirtname" class="finp" value="${p.shirtname||''}"/></div>`;
  const fields=getStatFields(clubId,p.pos);
  $('pi-stats-edit').innerHTML=`<div style="display:grid;grid-template-columns:repeat(${Math.min(fields.length,3)},1fr);gap:9px;margin-top:10px">${fields.map(f=>f.computed?'':`<div><label class="flbl">${f.lbl}</label><input id="pi-stat-${f.key}" type="number" class="finp" min="0" value="${p[f.key]||0}"/></div>`).join('')}</div>`;
  $('pi-edit-avatar').innerHTML=avH(p.name,p.img,72,club.primary,club.accent);
  $('pi-view').style.display='none';$('pi-edit').style.display='';
}
function switchToViewPlayer(){$('pi-view').style.display='';$('pi-edit').style.display='none';}
function onPlayerEditPhoto(e){
  const file=e.target.files[0];if(!file)return;
  const club=getClub(clubId);
  const r=new FileReader();
  r.onload=ev=>{
    piNewPhoto=ev.target.result; // keep as dataURL for preview & fallback
    piNewPhotoFile=file;         // keep raw file for direct upload
    $('pi-edit-avatar').innerHTML=`<img src="${piNewPhoto}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid ${club.accent}"/>`;
  };
  r.readAsDataURL(file);
}
async function savePlayerEdit(){
  const p=clubData[clubId].players.find(pl=>pl.id===viewingPid);if(!p)return;
  const isNB=isNetball(clubId);
  p.name=$('pi-name').value.trim()||p.name;p.num=parseInt($('pi-num').value)||p.num;p.pos=$('pi-pos').value||p.pos;
  p.age=parseInt($('pi-age').value)||0;p.nationality=$('pi-nationality').value.trim();p.hometown=$('pi-hometown').value.trim();p.height=parseInt($('pi-height').value)||0;p.bio=$('pi-bio').value.trim();
  p.shirtname=$('pi-shirtname')?.value.trim()||'';
  if(!isNB)p.foot=$('pi-foot')?.value||'';
  getStatFields(clubId,p.pos).forEach(f=>{const el=$('pi-stat-'+f.key);if(el)p[f.key]=parseInt(el.value)||0;});
  if(piNewPhoto!==undefined){
    if(piNewPhoto===null){
      p.img=null;
    } else if(piNewPhotoFile){
      try{
        p.img = await uploadImageToStorage(piNewPhotoFile, 'players');
      }catch(e){
        showToast('Photo Upload Failed', e.message||'Could not upload photo — player details saved without changing the photo.');
      }
    }
  }
  if(dbConnected){
    try { await dbSavePlayer(viewingPid,p); }
    catch(e){ showToast('Save Error','Could not save player: '+e.message); return; }
  }
  sv('uc_data_v7',clubData);writeLog('player_updated','player',{player_id:viewingPid,details:{name:p.name}});
  showToast('Player Updated',p.name+' saved.');cm('m-player-info');renderPlayers();
}
function confirmDeletePlayer(){
  if(!requireOwner('Removing a player'))return;
  const p=getData(clubId).players.find(pl=>pl.id===viewingPid);if(!p)return;
  showConfirm('Remove Player',`Remove ${p.name} from the squad?`,'Yes, Remove',async()=>{
    if(dbConnected){ await dbDeletePlayer(viewingPid); }
    clubData[clubId].players=clubData[clubId].players.filter(pl=>pl.id!==viewingPid);
    sv('uc_data_v7',clubData);cm('m-player-info');renderPlayers();renderTabAct();
    writeLog('player_deleted','player',{details:{name:p.name}});showToast('Player Removed',`${p.name} removed.`);
  });
}

function openDelRatings(){
  const md=getData(clubId)?.matchdays?.find(m=>m.id===mdId);
  $('del-md-name').textContent=md?`vs ${md.opponent}`:'this matchday';
  const players=getData(clubId)?.players||[];
  $('del-player-sel').innerHTML='<option value="">Select player</option>'+players.map(p=>`<option value="${p.id}">${p.name} (#${p.num})</option>`).join('');
  openModal('m-del-ratings');
}
function deleteRatingsForMd(){
  if(!requireOwner('Deleting ratings'))return;
  const md=getData(clubId)?.matchdays?.find(m=>m.id===mdId);
  showConfirm('Delete Matchday Ratings',`Delete all ratings for vs ${md?.opponent||'this match'}?`,'Yes, Delete',async()=>{
    if(dbConnected){ await dbDeleteRatingsForMatchday(mdId); }
    const players=getData(clubId)?.players||[];
    players.forEach(p=>{delete ratings[clubId+'_'+mdId+'_'+p.id];const rk=clubId+'_'+p.id;if(ratings[rk])Object.keys(ratings[rk]).forEach(k=>{if(k.includes(mdId))delete ratings[rk][k];});});
    sv('uc_ratings_v7',ratings);writeLog('ratings_deleted','rating',{matchday_id:mdId});
    cm('m-del-ratings');showToast('Ratings Deleted','All matchday ratings removed.');renderMd();
  });
}
function deleteRatingsForPlayer(){
  if(!requireOwner('Deleting ratings'))return;
  const pid=$('del-player-sel').value;if(!pid){showToast('No player selected','Please choose a player first.');return;}
  const p=getData(clubId)?.players?.find(pl=>pl.id===pid);
  showConfirm('Delete Player Ratings',`Delete all ratings for ${p?.name||'this player'} in this matchday?`,'Yes, Delete',async()=>{
    if(dbConnected){ await dbDeleteRatingsForPlayerInMatchday(mdId,pid); }
    delete ratings[clubId+'_'+mdId+'_'+pid];const rk=clubId+'_'+pid;if(ratings[rk])Object.keys(ratings[rk]).forEach(k=>{if(k.includes(mdId))delete ratings[rk][k];});
    sv('uc_ratings_v7',ratings);cm('m-del-ratings');showToast('Player Ratings Deleted',`Ratings for ${p?.name||'player'} removed.`);renderMd();
  });
}
function deleteAllRatingsForClub(){
  if(!requireOwner('Deleting all club ratings'))return;
  const club=getClub(clubId);
  showConfirm('Delete ALL Club Ratings',`Delete every rating for ${club?.short||'this club'}?`,'Yes, Delete All',async()=>{
    if(dbConnected){ await dbDeleteAllRatingsForClub(clubId); }
    Object.keys(ratings).filter(k=>k.startsWith(clubId)).forEach(k=>delete ratings[k]);
    sv('uc_ratings_v7',ratings);writeLog('ratings_deleted','rating',{});
    cm('m-del-ratings');showToast('All Ratings Deleted','All club ratings cleared.');renderMd();
  });
}
function deleteCurrentMatchday(){
  if(!requireOwner('Deleting a matchday'))return;
  const md=getData(clubId)?.matchdays?.find(m=>m.id===mdId);if(!md)return;
  showConfirm('Delete Matchday',`Permanently delete ${md.label} vs ${md.opponent}?`,'Yes, Delete All',async()=>{
    if(dbConnected){ await dbDeleteMatchday(mdId); }
    const players=getData(clubId)?.players||[];
    players.forEach(p=>{delete ratings[clubId+'_'+mdId+'_'+p.id];delete comments[clubId+'_'+mdId+'_'+p.id];});
    delete scorers[clubId+'_'+mdId];delete lineups[clubId+'_'+mdId];
    clubData[clubId].matchdays=clubData[clubId].matchdays.filter(m=>m.id!==mdId);
    sv('uc_data_v7',clubData);sv('uc_ratings_v7',ratings);sv('uc_cmts_v7',comments);sv('uc_scorers_v7',scorers);sv('uc_lineups_v7',lineups);
    writeLog('matchday_deleted','matchday',{matchday_id:mdId});
    mdId=null;stopTimer();showV('club');renderClub();showToast('Matchday Deleted','Matchday removed.');
  });
}

function openModal(id){$(id).classList.add('open');}
function cm(id){
  $(id).classList.remove('open');
  if(id==='m-manage-match' && mmInterval){ clearInterval(mmInterval); mmInterval=null; }
}
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open');}));
let _confirmCb=null;
function showConfirm(title,msg,okLabel,cb){$('confirm-title').textContent=title;$('confirm-msg').textContent=msg;$('confirm-ok-btn').textContent=okLabel||'Yes, Delete';_confirmCb=cb;openModal('m-confirm');}
function execConfirm(){cm('m-confirm');if(typeof _confirmCb==='function')_confirmCb();_confirmCb=null;}

function openEditClub(){
  const club=getClub(clubId);newLogoData=undefined;newLogoFile=undefined;
  $('ec-name').value=club.name;$('ec-short').value=club.short;$('ec-tag').value=club.tagline;
  $('ec-desc').value=clubDescriptions[clubId]||'';
  ['p','a','h'].forEach((k,i)=>{const col=['primary','accent','highlight'][i];$('ec-'+k+'-c').value=club[col]||'#000';$('ec-'+k+'-h').value=club[col]||'#000';});
  updClubPrev();$('club-logo-pre').innerHTML=`<img class="logo-pre" src="${club.logo||DEF_LOGOS[club.id]||''}"/>`;$('rm-logo-btn').style.display=club.logo?'':'none';openModal('m-club');
}
function onLogoUpload(e){const file=e.target.files[0];if(!file)return;newLogoFile=file;const r=new FileReader();r.onload=ev=>{newLogoData=ev.target.result;$('club-logo-pre').innerHTML=`<img class="logo-pre" src="${newLogoData}"/>`;$('rm-logo-btn').style.display='';};r.readAsDataURL(file);}
function rmLogo(){newLogoData=null;newLogoFile=undefined;const club=getClub(clubId);$('club-logo-pre').innerHTML=`<img class="logo-pre" src="${DEF_LOGOS[club.id]||''}"/>`;$('rm-logo-btn').style.display='none';}
function syncC(k){const v=$('ec-'+k+'-c').value;$('ec-'+k+'-h').value=v;updClubPrev();}
function syncCH(k){const v=$('ec-'+k+'-h').value;if(/^#[0-9a-fA-F]{6}$/.test(v)){$('ec-'+k+'-c').value=v;updClubPrev();}}
function updClubPrev(){const name=$('ec-name').value||'Club Name',tag=$('ec-tag').value||'Tagline',pri=$('ec-p-h').value||'#1d2d5a',acc=$('ec-a-h').value||'#4dc8c8';const box=$('ec-prev');box.style.background=pri;box.style.borderColor=acc;$('ec-pname').textContent=name;$('ec-ptag').textContent=tag;$('ec-ptag').style.color=acc;}
async function saveClub(){
  const idx=clubs.findIndex(c=>c.id===clubId);if(idx<0)return;
  clubs[idx].name=$('ec-name').value.trim()||clubs[idx].name;clubs[idx].short=$('ec-short').value.trim()||clubs[idx].short;clubs[idx].tagline=$('ec-tag').value.trim();
  clubs[idx].primary=$('ec-p-h').value||clubs[idx].primary;clubs[idx].accent=$('ec-a-h').value||clubs[idx].accent;clubs[idx].highlight=$('ec-h-h').value||clubs[idx].highlight;
  if(newLogoData===null){
    clubs[idx].logo=null;
  } else if(newLogoFile){
    try{ clubs[idx].logo = await uploadImageToStorage(newLogoFile, 'clubs'); }
    catch(e){ showToast('Logo Upload Failed', e.message||'Could not upload logo — other club details still saved.'); }
  }
  sv('uc_clubs_v7',clubs);
  const descText=$('ec-desc').value.trim();
  clubDescriptions[clubId]=descText;sv('uc_clubdesc_v7',clubDescriptions);
  if(dbConnected){ await dbSaveClub(clubId,clubs[idx]); await saveClubDescToDB(clubId,descText); }
  document.documentElement.style.setProperty('--c-accent',clubs[idx].accent);document.documentElement.style.setProperty('--c-primary',clubs[idx].primary);$('hdr-club').textContent=clubs[idx].short;
  writeLog('club_updated','club',{});cm('m-club');renderClub();showToast('Club Updated','Club details saved.');
}

// Save original image as-is (full quality, no compression or resizing)
function readFileAsDataURL(file){
  return new Promise(function(resolve,reject){
    const r=new FileReader();
    r.onload=function(e){resolve(e.target.result);};
    r.onerror=reject;
    r.readAsDataURL(file);
  });
}

function openPp(pid){editingPicPid=pid;newPicData=undefined;newPicFile=undefined;const p=getData(clubId).players.find(pl=>pl.id===pid),club=getClub(clubId);$('pp-pre-wrap').innerHTML=p.img?`<img class="pp-pre" src="${p.img}" alt="${p.name}"/>`:`<div class="pp-pre-av" style="border-color:${club.accent};color:${club.accent}">${p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>`;$('rm-pp-btn').style.display=p.img?'':'none';$('pp-file').value='';openModal('m-pp');}
function onPpUpload(e){
  const file=e.target.files[0];if(!file)return;
  const r=new FileReader();
  r.onload=ev=>{
    newPicData=ev.target.result;
    newPicFile=file;
    $('pp-pre-wrap').innerHTML=`<img class="pp-pre" src="${newPicData}"/>`;
    $('rm-pp-btn').style.display='';
  };
  r.readAsDataURL(file);
}
function rmPlayerPic(){newPicData=null;const p=getData(clubId).players.find(pl=>pl.id===editingPicPid),club=getClub(clubId);$('pp-pre-wrap').innerHTML=`<div class="pp-pre-av" style="border-color:${club.accent};color:${club.accent}">${p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>`;$('rm-pp-btn').style.display='none';}
async function savePp(){
  if(newPicData===undefined){cm('m-pp');return;}
  const p=clubData[clubId].players.find(pl=>pl.id===editingPicPid);
  if(!p)return;
  if(newPicData===null){
    p.img=null;
  } else if(newPicFile){
    try{
      p.img = await uploadImageToStorage(newPicFile, 'players');
    }catch(e){
      showToast('Photo Upload Failed', e.message||'Could not upload photo.');return;
    }
  }
  if(dbConnected){
    try{ await dbSavePlayer(editingPicPid,p); }
    catch(e){ showToast('Save Error','Could not save photo: '+e.message); return; }
  }
  sv('uc_data_v7',clubData);
  cm('m-pp');renderPlayers();showToast('Photo Updated','Player photo saved.');
}

function openAddPlayer(){const club=getClub(clubId);$('np-pos').innerHTML=POSITIONS[club.sport].map(p=>`<option value="${p}">${p}</option>`).join('');$('np-name').value='';$('np-num').value='';openModal('m-add-player');}
async function doAddPlayer(){
  const name=$('np-name').value.trim(),num=parseInt($('np-num').value)||1,pos=$('np-pos').value;if(!name)return;
  const isNB=isNetball(clubId);
  const newP={id:'p'+Date.now(),name,num,pos,goals:0,assists:0,gp:0,img:null,age:0,nationality:'',hometown:'',height:0,foot:'',shirtname:'',bio:''};
  if(isNB){newP.attempts=0;newP.intercepts=0;}
  if(dbConnected){
    const dbRow=await dbAddPlayer(clubId,newP);
    if(dbRow){newP.id=dbRow.id;newP._dbId=dbRow.id;}
  }
  clubData[clubId].players.push(newP);sv('uc_data_v7',clubData);writeLog('player_added','player',{details:{name}});cm('m-add-player');renderPlayers();renderTabAct();showToast('Player Added',`${name} added.`);
}

function openAddMd(){$('nm-lbl').value='';$('nm-opp').value='';$('nm-venue').value='';$('nm-date').value='';$('nm-time').value='';$('nm-res').value='';$('nm-duration').value='90';openModal('m-add-md');}
async function doAddMd(){
  const lbl=$('nm-lbl').value.trim(),opp=$('nm-opp').value.trim(),venue=$('nm-venue').value.trim(),date=$('nm-date').value,time=$('nm-time').value,res=$('nm-res').value.trim(),dur=$('nm-duration').value;
  if(!lbl||!opp)return;
  const newMd={id:'md'+Date.now(),label:lbl,opponent:opp,venue,date,kickoffTime:time,result:res,status:'upcoming',homeGoals:0,awayGoals:0,ratingWindowHrs:24,forceClose:false,forceOpen:false,ratingOpenOverride:null,durationKey:dur,matchStartedAt:0,currentHalf:1,halfStartedAt:0,htPaused:false,htPauseStart:0,htPausedTotal:0};
  if(dbConnected){
    const dbMd=await dbSaveMatchday(clubId,newMd);
    if(dbMd){newMd._dbId=dbMd.id;}
  }
  clubData[clubId].matchdays.push(newMd);sv('uc_data_v7',clubData);
  writeLog('matchday_created','matchday',{matchday_id:newMd.id,details:{label:lbl,opponent:opp,venue}});
  cm('m-add-md');renderMatchdays();
  if(date&&time)sendNotif('New Match Added',`${getClub(clubId).short} vs ${opp} on ${date} @ ${time}${venue?' at '+venue:''}`);
}

function toggleRatingOverride(){const dur=$('er-duration')?.value||'90';const nbQ=$('netball-quarters-edit');if(nbQ)nbQ.style.display=dur.includes('nb')?'':'none';}
async function reopenRatings(mid){
  const md=getData(clubId)?.matchdays?.find(m=>m.id===mid);if(!md)return;
  showConfirm('Reopen Ratings',`Let fans rate players again for vs ${md.opponent}?`,'Yes, Reopen',async()=>{
    const prevOpen=md.forceOpen,prevClose=md.forceClose;
    md.forceOpen=true;md.forceClose=false;
    sv('uc_data_v7',clubData);
    renderMd();
    if(dbConnected){
      try{
        await sb('PATCH','matchdays',{eq:{id:md._dbId||md.id},data:{force_open:true,force_close:false}});
        writeLog('ratings_reopened','rating',{matchday_id:mid});
        showToast('Ratings Reopened',`Fans can rate players again for vs ${md.opponent}.`);
      }catch(e){
        md.forceOpen=prevOpen;md.forceClose=prevClose;sv('uc_data_v7',clubData);renderMd();
        showToast('Not Saved', e.message || 'Could not reach the server.');
        console.error('reopenRatings failed:', e);
      }
    } else {
      showToast('Reopened (offline)','Saved on this device only — reconnect to sync to the server.');
    }
  });
}
async function closeRatingsOverride(mid){
  const md=getData(clubId)?.matchdays?.find(m=>m.id===mid);if(!md)return;
  showConfirm('Close Ratings',`Stop fans from rating players for vs ${md.opponent}?`,'Yes, Close',async()=>{
    const prevOpen=md.forceOpen,prevClose=md.forceClose;
    md.forceOpen=false;md.forceClose=true;
    sv('uc_data_v7',clubData);
    renderMd();
    if(dbConnected){
      try{
        await sb('PATCH','matchdays',{eq:{id:md._dbId||md.id},data:{force_open:false,force_close:true}});
        writeLog('ratings_closed','rating',{matchday_id:mid});
        showToast('Ratings Closed',`Rating window closed for vs ${md.opponent}.`);
      }catch(e){
        md.forceOpen=prevOpen;md.forceClose=prevClose;sv('uc_data_v7',clubData);renderMd();
        showToast('Not Saved', e.message || 'Could not reach the server.');
        console.error('closeRatingsOverride failed:', e);
      }
    } else {
      showToast('Closed (offline)','Saved on this device only — reconnect to sync to the server.');
    }
  });
}
function openEditMd(mid){
  editMdId=mid;const md=getData(clubId).matchdays.find(m=>m.id===mid);
  $('er-lbl').value=md.label||'';$('er-opp').value=md.opponent||'';$('er-venue').value=md.venue||'';
  $('er-date').value=md.date||'';$('er-time').value=md.kickoffTime||'';$('er-status').value=md.status||'upcoming';
  $('er-duration').value=md.durationKey||'90';$('er-v').value=md.result||'';
  $('er-home').value=md.homeGoals||0;$('er-away').value=md.awayGoals||0;
  $('er-window').value=md.ratingWindowHrs||24;$('er-force-close').checked=!!md.forceClose;$('er-force-open').checked=!!md.forceOpen;
  if(md.ratingOpenOverride){const d=new Date(md.ratingOpenOverride);$('er-rating-date').value=d.toISOString().split('T')[0];$('er-rating-time').value=d.toTimeString().slice(0,5);}
  else{$('er-rating-date').value='';$('er-rating-time').value='';}
  toggleRatingOverride();openModal('m-edit-md');
}
async function doSaveMdEdit(){
  const md=clubData[clubId].matchdays.find(m=>m.id===editMdId);if(!md)return;
  const oldStatus=md.status,roDate=$('er-rating-date').value,roTime=$('er-rating-time').value;
  md.label=$('er-lbl').value.trim()||md.label;md.opponent=$('er-opp').value.trim()||md.opponent;md.venue=$('er-venue').value.trim();
  md.result=$('er-v').value.trim();md.date=$('er-date').value;md.kickoffTime=$('er-time').value;md.status=$('er-status').value;
  md.homeGoals=parseInt($('er-home').value)||0;md.awayGoals=parseInt($('er-away').value)||0;
  md.ratingWindowHrs=parseInt($('er-window').value)||24;
  md.forceOpen=$('er-force-open').checked;
  md.forceClose=$('er-force-close').checked;
  if(md.forceOpen)md.forceClose=false; // the two overrides can't both be true
  if(md.forceClose)md.forceOpen=false;
  md.durationKey=$('er-duration').value||'90';
  md.ratingOpenOverride=roDate?new Date(roDate+'T'+(roTime||'00:00')).getTime():null;
  if(md.forceClose)md.status='finished';
  if(md.status==='live'&&oldStatus!=='live'){
    // Same "Go Live" behaviour as the Manage Match button — the clock
    // starts now, not at the scheduled kickoff time.
    md.matchStartedAt=Date.now();md.currentHalf=1;md.halfStartedAt=Date.now();
    md.htPaused=false;md.htPauseStart=0;md.htPausedTotal=0;
  }
  if(dbConnected){ await dbSaveMatchday(clubId,{...md,_dbId:md._dbId||editMdId}); }
  sv('uc_data_v7',clubData);cm('m-edit-md');
  writeLog(md.status==='live'?'status_changed_live':'matchday_updated','matchday',{matchday_id:editMdId});
  const club=getClub(clubId);
  if(oldStatus!=='live'&&md.status==='live')sendNotif('Match is LIVE!',`${club.short} vs ${md.opponent} is live!`);
  else sendNotif('Match Updated',`${club.short} vs ${md.opponent} saved.`);
  if(mdId===editMdId){if(md.status==='live')startTimer(md);else stopTimer();renderMd();}else{renderMatchdays();updateLiveIndicator();}
}

let editingHeadlineId=null;
function openAddNews(){
  editingHeadlineId=null;
  $('news-modal-title').textContent='Add Headline';$('news-save-btn').textContent='Add';
  $('nh-t').value='';$('nh-d').value=new Date().toISOString().split('T')[0];$('nh-body').value='';
  openModal('m-news');
}
function openEditNews(hid){
  const h=getData(clubId)?.headlines?.find(x=>String(x.id)===String(hid));if(!h)return;
  editingHeadlineId=hid;
  $('news-modal-title').textContent='Edit Headline';$('news-save-btn').textContent='Save Changes';
  $('nh-t').value=h.title||'';$('nh-d').value=h.date||'';$('nh-body').value=h.body||'';
  openModal('m-news');
}
async function doAddHeadline(){
  const t=$('nh-t').value.trim(),d=$('nh-d').value,body=$('nh-body').value;if(!t)return;
  if(editingHeadlineId){
    const h=clubData[clubId].headlines.find(x=>String(x.id)===String(editingHeadlineId));
    if(h){ h.title=t;h.date=d;h.body=body; }
    if(dbConnected){ await dbUpdateHeadline(editingHeadlineId,t,d,body); }
    writeLog('headline_updated','headline',{details:{title:t}});
  } else {
    var hId=Date.now();
    if(dbConnected){ var dbH=await dbSaveHeadline(clubId,t,d,body); if(dbH){hId=dbH.id;} }
    if(!clubData[clubId].headlines)clubData[clubId].headlines=[];
    clubData[clubId].headlines.push({id:hId,title:t,date:d,body});
    writeLog('headline_added','headline',{details:{title:t}});
  }
  sv('uc_data_v7',clubData);cm('m-news');renderNews();
  editingHeadlineId=null;
}
// Fan-facing: shows the full story. Headlines/previews everywhere else
// only ever show the title (the "highlight") — this is where the full
// body text actually gets read.
function openNewsDetail(cid,hid){
  const club=getClub(cid);
  const h=getData(cid)?.headlines?.find(x=>String(x.id)===String(hid));if(!h)return;
  $('nd-title').textContent=h.title;
  $('nd-meta').innerHTML=`<span style="color:${club?club.accent:'#4dc8c8'};font-weight:700">${club?club.short:''}</span>${h.date?' &middot; '+h.date:''}`;
  $('nd-body').textContent=h.body&&h.body.trim()?h.body:'No further details for this story yet.';
  openModal('m-news-detail');
}

function openEditStats(pid){
  editingStatsPid=pid;const p=getData(clubId).players.find(pl=>pl.id===pid);
  const fields=getStatFields(clubId,p.pos).filter(f=>!f.computed);
  $('stats-fields').innerHTML=`<div style="display:grid;grid-template-columns:repeat(${Math.min(fields.length,3)},1fr);gap:9px">${fields.map(f=>`<div><label class="flbl">${f.lbl}</label><input id="es-${f.key}" type="number" class="finp" min="0" value="${p[f.key]||0}"/></div>`).join('')}</div>`;
  openModal('m-stats');
}
async function doSaveStats(){
  const p=clubData[clubId].players.find(pl=>pl.id===editingStatsPid);if(!p)return;
  getStatFields(clubId,p.pos).forEach(f=>{if(f.computed)return;const el=$('es-'+f.key);if(el)p[f.key]=parseInt(el.value)||0;});
  if(dbConnected){
    try { await dbSavePlayer(editingStatsPid,p); }
    catch(e){ return; }
  }
  sv('uc_data_v7',clubData);cm('m-stats');renderPlayers();
}


function renderLiveScorerStrip(club, sc, isLive){
  var strip=$('live-scorers-strip');
  if(!strip)return;
  var goals=(sc&&sc.goals)||[];
  var assists=(sc&&sc.assists)||[];
  if(!isLive||goals.length===0){strip.style.display='none';return;}
  strip.style.display='';
  var isNB=isNetball(clubId);
  var goalIcon=GOAL_SVG;
  var h='<div style="display:flex;flex-wrap:wrap;gap:7px;align-items:center">';
  h+='<span style="font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:'+(club?club.primary:'#1d2d5a')+';flex-shrink:0">'+goalIcon+' Scorers</span>';
  groupEvtsForChips(goals).forEach(function(g){
    var minsH=g.minutes.map(function(m){return '<span style="color:'+(club?club.accent:'#4dc8c8')+';font-size:11px">'+m+"'</span>";}).join(' ');
    h+='<span style="display:inline-flex;align-items:center;gap:5px;background:'+(club?club.primary:'#1d2d5a')+';color:#fff;border-radius:20px;padding:5px 13px;font-size:13px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.15)">'+
      '<span>'+goalIcon+'</span>'+
      '<span>'+lastNameOf(g.name)+'</span>'+
      minsH+
    '</span>';
  });
  if(assists.length){
    h+='<span style="font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#888;flex-shrink:0;margin-left:4px">'+ASSIST_SVG+' Assists</span>';
    groupEvtsForChips(assists).forEach(function(a){
      var minsH=a.minutes.map(function(m){return '<span style="color:#f39c12;font-size:11px">'+m+"'</span>";}).join(' ');
      h+='<span style="display:inline-flex;align-items:center;gap:5px;background:#f0f0f5;color:#444;border-radius:20px;padding:5px 13px;font-size:12px;font-weight:600;border:1.5px solid #e0e0e8">'+
        '<span>'+ASSIST_SVG+'</span>'+
        '<span>'+lastNameOf(a.name)+'</span>'+
        minsH+
      '</span>';
    });
  }
  h+='</div>';
  strip.innerHTML=h;
}


let logsHubTab = 'standings';
let lbHubTab = 'all';

function openLogsHub(){
  showV('logshub');
  renderLogsHub();
}

function switchLogsTab(tab){
  logsHubTab = tab;
  document.querySelectorAll('.hub-tab[id^="lht-"]').forEach(b => {
    b.classList.toggle('active', b.id === 'lht-'+tab);
  });
  document.querySelectorAll('.lh-panel').forEach(p => p.style.display='none');
  var panel = $('lh-'+tab);
  if(panel) panel.style.display = '';
  renderLogsHubTab(tab);
}

function renderLogsHub(){
  switchLogsTab('standings');
}

function renderLogsHubTab(tab){
  if(tab === 'standings') renderHubStandings();
  else if(tab === 'fixtures') renderHubFixtures();
  else if(tab === 'stats') renderHubStats();
  else if(tab === 'live') renderHubLive();
}

function renderHubStandings(){
  var panel=$('lh-standings');if(!panel)return;
  var html='';
  clubs.forEach(function(club){
    var rows=standings[club.id]||[],isNB=isNetball(club.id);
    sortStandingsRows(rows,isNB);
    var hdrs=isNB?['Team','P','W','D','L','F','A','GD','Pts','PCT']:['Team','P','W','D','L','GD','Pts'];
    html+='<div class="standings-club-block">';
    html+='<div class="standings-club-hdr" style="background:'+club.primary+'">';
    html+='<img src="'+logoSrc(club)+'" style="width:28px;height:28px;object-fit:contain;border-radius:6px;flex-shrink:0"/>';
    html+='<div class="standings-club-hdr-name" style="color:'+club.accent+';flex:1">'+club.name+'</div>';
    if(isAdmin){
      html+='<button onclick="openStandings(\''+club.id+'\')" style="padding:5px 12px;border-radius:7px;border:1.5px solid '+club.accent+';color:'+club.accent+';background:transparent;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">&#9998; Edit</button>';
    }
    html+='</div>';
    if(!rows.length){
      html+='<div class="standings-no-data">No standings posted yet'+(isAdmin?' — click Edit to add some.':'.')+'</div>';
    } else {
      html+='<div class="standings-table-wrap"><table class="standings-table">';
      html+='<thead><tr style="background:'+club.primary+'08">'+hdrs.map(function(h){
        return '<th style="color:'+club.accent+';text-align:'+(h==='Team'?'left':'center')+'">'+h+'</th>';
      }).join('')+'</tr></thead><tbody>';
      rows.forEach(function(row,i){
        var pts=isNB?(row.w||0)*2+(row.d||0):(row.w||0)*3+(row.d||0);
        var gd=(row.gf||0)-(row.ga||0);
        var gdStr=(gd>=0?'+':'')+gd;
        var gdCol=gd>=0?'#2ecc71':'#e74c3c';
        var pct=isNB&&(row.p||0)>0?(pts/(row.p||1)/2).toFixed(3):'';
        html+='<tr>';
        html+='<td>'+( i+1)+'. '+teamNameLinkH(club.id,row.team)+'</td>';
        html+='<td>'+(row.p||0)+'</td>';
        html+='<td style="color:#2ecc71;font-weight:700">'+(row.w||0)+'</td>';
        html+='<td style="color:#f39c12">'+(row.d||0)+'</td>';
        html+='<td style="color:#e74c3c">'+(row.l||0)+'</td>';
        if(isNB){
          html+='<td>'+(row.gf||0)+'</td>';
          html+='<td>'+(row.ga||0)+'</td>';
        }
        html+='<td style="color:'+gdCol+'">'+gdStr+'</td>';
        html+='<td style="font-family:Oswald,sans-serif;font-size:17px;font-weight:700;color:'+club.accent+'">'+pts+'</td>';
        if(isNB) html+='<td style="color:#999;font-size:11px">'+pct+'</td>';
        html+='</tr>';
      });
      html+='</tbody></table></div>';
    }
    html+='</div>';
  });
  panel.innerHTML=html||'<div class="standings-no-data">No standings data yet.</div>';
}

let fixClubFilter='all';
let fixSection='upcoming';
function switchFixSection(sec){
  fixSection=sec;
  ['upcoming','results'].forEach(function(s){
    var btn=$('fixt-'+s);
    if(btn){btn.classList.toggle('active',s===sec);}
  });
  $('fix-upcoming-panel').style.display=sec==='upcoming'?'':'none';
  $('fix-results-panel').style.display=sec==='results'?'':'none';
}
function renderHubFixtures(){
  var filterBar=$('fix-filter-bar');
  if(!filterBar)return;
  // Build club filter pills
  var pillHtml='<button class="fix-pill'+(fixClubFilter==='all'?' active':'')+'" onclick="setFixFilter(\'all\')">All</button>';
  clubs.forEach(function(cl){
    pillHtml+='<button class="fix-pill'+(fixClubFilter===cl.id?' active':'')+'" style="'+(fixClubFilter===cl.id?'background:'+cl.primary+';color:#fff;border-color:'+cl.primary:'')+ '" onclick="setFixFilter(\''+cl.id+'\')">'+cl.short+'</button>';
  });
  filterBar.innerHTML=pillHtml;
  var targetClubs=fixClubFilter==='all'?clubs:clubs.filter(function(c){return c.id===fixClubFilter;});
  var upcomingHtml='',resultsHtml='';
  targetClubs.forEach(function(club){
    var mds=(getData(club.id)||{matchdays:[]}).matchdays;
    var upcoming=[],finished=[],live=[];
    mds.forEach(function(md){
      if(md.status==='live') live.push(md);
      else if(md.status==='finished') finished.push(md);
      else upcoming.push(md);
    });
    function mdNum(md){return parseInt((md.label||'').replace(/\D+/g,''))||0;}
    upcoming.sort(function(a,b){return mdNum(a)-mdNum(b);});
    finished.sort(function(a,b){return mdNum(a)-mdNum(b);});
    function fixCard(md){
      var paused=isMatchPaused(md),isLive=md.status==='live',isDone=md.status==='finished';
      var h='<div class="fixture-card'+(isLive?(paused?' paused-f':' live-f'):'')+'" onclick="viewMdFromLogsHub(\''+club.id+'\',\''+md.id+'\',\'fixtures\')" style="cursor:pointer">';
      h+='<div style="display:flex;align-items:center;gap:10px">';
      h+='<img src="'+logoSrc(club)+'" style="width:34px;height:34px;object-fit:contain;border-radius:8px;flex-shrink:0"/>';
      h+='<div style="flex:1;min-width:0">';
      h+='<div style="font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:'+club.accent+';margin-bottom:2px">'+md.label+' &middot; '+club.short+'</div>';
      h+='<div style="font-family:Oswald,sans-serif;font-size:15px;font-weight:700;color:#1a1a2e">'+club.short+' <span style="color:#ccc;font-size:12px;font-weight:400">vs</span> '+md.opponent+'</div>';
      if(md.venue) h+='<div style="font-size:11px;color:#aaa;margin-top:1px">&#128205; '+md.venue+'</div>';
      if(md.date) h+='<div style="font-size:11px;color:#aaa">&#128197; '+md.date+(md.kickoffTime?' &middot; '+md.kickoffTime:'')+'</div>';
      h+='</div>';
      if(isLive){
        h+='<div style="text-align:center;flex-shrink:0">';
        h+='<div style="font-family:Oswald,sans-serif;font-size:22px;font-weight:700;color:'+(paused?'#f39c12':'#e74c3c')+'">'+(md.homeGoals||0)+' - '+(md.awayGoals||0)+'</div>';
        h+=liveBadgeH(md,'font-size:9px');
        h+='</div>';
      } else if(isDone||md.result){
        h+='<div style="font-family:Oswald,sans-serif;font-size:16px;font-weight:700;color:'+club.accent+';flex-shrink:0">'+(md.result||((md.homeGoals||0)+' - '+(md.awayGoals||0)))+'</div>';
      } else {
        h+='<div style="font-size:11px;color:#bbb;flex-shrink:0">Tap for info</div>';
      }
      h+='</div></div>';
      return h;
    }
    if(live.length||upcoming.length){
      if(fixClubFilter==='all') upcomingHtml+='<div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:'+club.accent+';margin:10px 0 6px 2px">'+club.name+'</div>';
      live.forEach(function(md){upcomingHtml+=fixCard(md);});
      upcoming.forEach(function(md){upcomingHtml+=fixCard(md);});
    }
    if(finished.length){
      if(fixClubFilter==='all') resultsHtml+='<div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:'+club.accent+';margin:10px 0 6px 2px">'+club.name+'</div>';
      finished.forEach(function(md){resultsHtml+=fixCard(md);});
    }
  });
  $('fix-upcoming-panel').innerHTML=upcomingHtml||'<div class="standings-no-data">No upcoming fixtures.</div>';
  $('fix-results-panel').innerHTML=resultsHtml||'<div class="standings-no-data">No results yet.</div>';
  switchFixSection(fixSection);
}
function setFixFilter(cid){
  fixClubFilter=cid;
  renderHubFixtures();
}

async function openMatchDetail(cid,mid){
  var club=getClub(cid);
  var md=(getData(cid)||{matchdays:[]}).matchdays.find(function(m){return m.id===mid;});
  if(!club||!md)return;
  // Load scorers/lineup if not already in memory
  if(!scorers[cid+'_'+mid]&&dbConnected){
    await loadMatchdayDataFromDB(cid,mid);
  }
  var sc=scorers[cid+'_'+mid]||{goals:[],assists:[],cards:[]};
  var paused=isMatchPaused(md),isLive=md.status==='live',isDone=md.status==='finished';
  $('mdet-title').textContent=md.label+' — '+club.short+' vs '+md.opponent;
  var h='';
  // Header banner
  h+='<div style="background:'+club.primary+';border-radius:12px;padding:16px 20px;margin-bottom:14px">';
  h+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">';
  h+=logoH(club,40);
  h+='<div style="flex:1"><div style="font-family:Oswald,sans-serif;font-size:18px;font-weight:700;color:#fff">'+club.short+' vs '+md.opponent+'</div>';
  h+='<div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:'+club.accent+';margin-top:2px">'+md.label+'</div></div>';
  if(isLive||isDone){
    h+='<div style="text-align:right"><div style="font-family:Oswald,sans-serif;font-size:32px;font-weight:700;color:'+(paused?'#f39c12':isLive?'#e74c3c':club.accent)+'">'+(md.homeGoals||0)+' - '+(md.awayGoals||0)+'</div>';
    if(isLive) h+=liveBadgeH(md,'display:inline-flex;margin-top:4px');
    else h+='<div style="font-size:11px;color:rgba(255,255,255,.5);margin-top:2px">Full Time</div>';
    h+='</div>';
  }
  h+='</div>';
  // Match info
  if(md.date||md.kickoffTime) h+='<div style="font-size:12px;color:rgba(255,255,255,.6)">&#128197; '+( md.date||'')+(md.kickoffTime?' &middot; '+md.kickoffTime:'')+'</div>';
  if(md.venue) h+='<div style="font-size:12px;color:rgba(255,255,255,.6);margin-top:3px">&#128205; '+md.venue+'</div>';
  if(md.result&&!isDone) h+='<div style="font-size:13px;color:'+club.accent+';font-weight:700;margin-top:4px">Result: '+md.result+'</div>';
  h+='</div>';
  // Scorers & Assists
  if(sc.goals&&sc.goals.length){
    h+='<div style="margin-bottom:12px">';
    h+='<div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#888;margin-bottom:6px">⚽ Goalscorers</div>';
    groupEvtsForChips(sc.goals).forEach(function(g){
      h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5">';
      h+='<span style="font-size:18px">⚽</span>';
      h+='<span style="font-weight:700;color:#1a1a2e;flex:1">'+lastNameOf(g.name)+'</span>';
      if(g.minutes.length) h+='<span style="font-size:12px;color:#aaa;font-weight:600">'+g.minutes.map(function(m){return m+"\'";}).join(' ')+'</span>';
      h+='</div>';
    });
    h+='</div>';
  }
  if(sc.assists&&sc.assists.length){
    h+='<div style="margin-bottom:12px">';
    h+='<div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#888;margin-bottom:6px">🎯 Assists</div>';
    groupEvtsForChips(sc.assists).forEach(function(a){
      h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5">';
      h+='<span style="font-size:18px">🎯</span>';
      h+='<span style="font-weight:700;color:#1a1a2e;flex:1">'+lastNameOf(a.name)+'</span>';
      if(a.minutes.length) h+='<span style="font-size:12px;color:#aaa;font-weight:600">'+a.minutes.map(function(m){return m+"\'";}).join(' ')+'</span>';
      h+='</div>';
    });
    h+='</div>';
  }
  if(sc.cards&&sc.cards.length){
    h+='<div style="margin-bottom:12px">';
    h+='<div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#888;margin-bottom:6px">Cards</div>';
    sc.cards.forEach(function(c){
      var isRed=c.type==='red';
      h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5">';
      h+='<span style="display:inline-block;width:12px;height:16px;border-radius:2px;background:'+(isRed?'#e74c3c':'#f1c40f')+';flex-shrink:0"></span>';
      h+='<span style="font-weight:700;color:#1a1a2e;flex:1">'+c.name+'</span>';
      if(c.minute) h+='<span style="font-size:12px;color:#aaa;font-weight:600">'+c.minute+'\'</span>';
      h+='</div>';
    });
    h+='</div>';
  }
  if(!sc.goals?.length&&!sc.assists?.length&&!sc.cards?.length&&(isLive||isDone)){
    h+='<div style="color:#ccc;font-style:italic;font-size:13px;text-align:center;padding:10px 0">No events logged yet.</div>';
  }
  $('mdet-body').innerHTML=h;
  openModal('m-match-detail');
}

let statsClubFilter='all';
function renderHubStats(){
  var filterBar=$('stats-filter-bar'),panel=$('stats-content');
  if(!filterBar||!panel){
    // fallback for old HTML
    var fp=$('lh-stats');if(!fp)return;
    fp.innerHTML='<div class="standings-no-data">Please refresh the page.</div>';
    return;
  }
  var pillHtml='<button class="fix-pill'+(statsClubFilter==='all'?' active':'')+'" onclick="setStatsFilter(\'all\')">All</button>';
  clubs.forEach(function(cl){
    pillHtml+='<button class="fix-pill'+(statsClubFilter===cl.id?' active':'')+'" style="'+(statsClubFilter===cl.id?'background:'+cl.primary+';color:#fff;border-color:'+cl.primary:'')+'" onclick="setStatsFilter(\''+cl.id+'\')">'+cl.short+'</button>';
  });
  filterBar.innerHTML=pillHtml;
  var statGroupsDef=[
    {key:'goals',label:'Top Scorers',color:'#2ecc71',icon:'<span style="font-size:15px">⚽</span>'},
    {key:'assists',label:'Top Assists',color:'#3d7dd4',icon:ASSIST_SVG},
    {key:'yellowCards',label:'Yellow Cards',color:'#f1c40f',icon:'<svg viewBox="0 0 24 24" width="14" height="16"><rect x="5" y="2" width="14" height="20" rx="2" fill="#f1c40f"/></svg>'},
    {key:'redCards',label:'Red Cards',color:'#e74c3c',icon:'<svg viewBox="0 0 24 24" width="14" height="16"><rect x="5" y="2" width="14" height="20" rx="2" fill="#e74c3c"/></svg>'},
    {key:'cleanSheets',label:'Clean Sheets',color:'#4dc8c8',icon:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#4dc8c8" stroke-width="2"><path d="M20 7L9 18l-5-5"/></svg>'},
  ];
  var netballGroups=[
    {key:'goals',label:'Top Scorers',color:'#2ecc71',icon:'🏀'},
    {key:'assists',label:'Top Assists',color:'#3d7dd4',icon:ASSIST_SVG},
    {key:'intercepts',label:'Intercepts',color:'#f39c12',icon:'✋'},
    {key:'attempts',label:'Attempts',color:'#9b59b6',icon:'🎯'},
  ];
  var targetClubs=statsClubFilter==='all'?clubs:clubs.filter(function(c){return c.id===statsClubFilter;});
  var html='';
  targetClubs.forEach(function(club){
    var players=(getData(club.id)||{players:[]}).players;
    var groups=isNetball(club.id)?netballGroups:statGroupsDef;
    var clubHtml='';
    groups.forEach(function(sg){
      var list=players.filter(function(p){return (p[sg.key]||0)>0;});
      if(!list.length)return;
      list.sort(function(a,b){return (b[sg.key]||0)-(a[sg.key]||0);});
      clubHtml+='<div class="stat-section"><div class="stat-section-title" style="color:'+sg.color+'">'+sg.icon+' '+sg.label+'</div>';
      list.slice(0,5).forEach(function(p,i){
        var rClass=i===0?'r1':i===1?'r2':i===2?'r3':'rN';
        clubHtml+='<div class="stat-rank-item" onclick="openPlayerInfo(\''+p.id+'\',\''+club.id+'\')" style="cursor:pointer">';
        clubHtml+='<div class="stat-rank-n '+rClass+'">'+(i+1)+'</div>';
        clubHtml+=avH(p.name,p.img,40,club.primary,club.accent);
        clubHtml+='<div class="stat-rank-info"><div class="stat-rank-name">'+p.name+'</div><div class="stat-rank-sub">'+p.pos+' &middot; <span style="color:'+club.accent+';font-weight:700">'+club.short+'</span></div></div>';
        clubHtml+='<div class="stat-rank-val" style="color:'+sg.color+'">'+(p[sg.key]||0)+'</div>';
        clubHtml+='</div>';
      });
      clubHtml+='</div>';
    });
    if(!clubHtml)return;
    html+='<div class="standings-club-block"><div class="standings-club-hdr" style="background:'+club.primary+'"><img src="'+logoSrc(club)+'" style="width:28px;height:28px;object-fit:contain;border-radius:6px;flex-shrink:0"/><div class="standings-club-hdr-name" style="color:'+club.accent+';flex:1">'+club.name+'</div></div>'+clubHtml+'</div>';
  });
  panel.innerHTML=html||'<div class="standings-no-data">No stats logged yet.</div>';
}
function setStatsFilter(cid){statsClubFilter=cid;renderHubStats();}

function renderHubLive(){
  var panel=$('lh-live');if(!panel)return;
  var liveMds=[];
  clubs.forEach(function(club){
    (getData(club.id)||{matchdays:[]}).matchdays.forEach(function(md){
      if(md.status==='live') liveMds.push({club:club,md:md});
    });
  });
  if(!liveMds.length){
    panel.innerHTML='<div class="lb-empty"><div class="lb-empty-icon"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#ddd" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></div><div class="lb-empty-title">No live matches</div><div class="lb-empty-sub">Check back when a match is in progress</div></div>';
    return;
  }
  var html='';
  liveMds.forEach(function(item){
    var club=item.club,md=item.md;
    var sc=scorers[club.id+'_'+md.id]||{goals:[],assists:[],cards:[]};
    var paused=isMatchPaused(md);
    html+='<div class="live-match-full-card" style="border-color:'+(paused?'rgba(243,156,18,.3)':'rgba(231,76,60,.2)')+'">';
    html+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">';
    html+=logoH(club,46);
    html+='<div style="flex:1"><div style="font-family:Oswald,sans-serif;font-size:18px;font-weight:700;color:#1a1a2e">'+club.short+' vs '+md.opponent+'</div>';
    if(md.venue) html+='<div style="font-size:11px;color:#aaa;margin-top:2px">&#128205; '+md.venue+'</div>';
    html+='</div>';
    html+='<div style="text-align:center">';
    html+='<div class="lmf-score" style="color:'+(paused?'#f39c12':'#e74c3c')+'">'+(md.homeGoals||0)+' - '+(md.awayGoals||0)+'</div>';
    html+=liveBadgeH(md,'margin-top:4px;display:inline-flex');
    html+='</div>';
    html+='</div>';
    if(sc.goals&&sc.goals.length){
      html+='<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">';
      groupEvtsForChips(sc.goals).forEach(function(g){
        var mins=g.minutes.map(function(m){return "'"+m;}).join(' ');
        html+='<span style="background:'+club.primary+';color:#fff;border-radius:50px;padding:3px 10px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>'+lastNameOf(g.name)+(mins?' '+mins:'')+'</span>';
      });
      groupEvtsForChips(sc.assists||[]).forEach(function(a){
        var mins=a.minutes.map(function(m){return "'"+m;}).join(' ');
        html+='<span style="background:#f0f2f7;color:#555;border-radius:50px;padding:3px 10px;font-size:11px;font-weight:600;border:1px solid #e0e4ef">A '+lastNameOf(a.name)+(mins?' '+mins:'')+'</span>';
      });
      html+='</div>';
    }
    var _lc=paused?'#f39c12':'#e74c3c';
    html+='<button data-cid="'+club.id+'" data-mid="'+md.id+'" onclick="viewMdFromLogsHub(this.dataset.cid,this.dataset.mid,\'live\')" style="width:100%;padding:9px;border-radius:9px;border:1.5px solid '+_lc+';background:#fff;color:'+_lc+';font-weight:700;font-size:13px;cursor:pointer">View Live Match &rarr;</button>';
    html+='</div>';
  });
  panel.innerHTML=html;
}

// =====================================================================
// NEWS HUB
// =====================================================================
function openNewsHub(){
  showV('newshub');
  renderNewsHub();
}

function renderNewsHub(){
  var el=$('newshub-content');if(!el)return;
  var html='';
  clubs.forEach(function(club){
    var cid=club.id;
    var headlines=(getData(cid)||{headlines:[]}).headlines||[];
    if(!headlines.length)return;
    html+='<div class="news-club-section">';
    html+='<div class="news-club-header" style="border-color:'+club.accent+'20">';
    html+='<img src="'+logoSrc(club)+'" style="width:28px;height:28px;object-fit:contain;border-radius:6px;flex-shrink:0"/>';
    html+='<div><div class="news-club-name" style="color:'+club.primary+'">'+club.short+'</div>';
    html+='<div style="font-size:10px;color:'+club.accent+';font-weight:700;letter-spacing:.5px;text-transform:uppercase">'+club.sport+'</div></div>';
    html+='</div>';
    headlines.forEach(function(h){
      html+='<div class="news-card" data-cid="'+cid+'" data-hid="'+h.id+'" onclick="openNewsDetail(this.dataset.cid,this.dataset.hid)">';
      html+='<div class="news-card-title">'+h.title+'</div>';
      html+='<div class="news-card-meta"><span style="color:'+club.accent+';font-weight:700">'+club.short+'</span> &bull; '+( h.date||'')+'</div>';
      html+='</div>';
    });
    html+='</div>';
  });
  el.innerHTML=html||'<div class="standings-no-data" style="padding:60px">No news posted yet.</div>';
}

function openLeaderboardHub(){
  showV('leaderboard');
  renderLeaderboardHub('all');
  if(dbConnected){
    Promise.all(clubs.map(c=>loadAllRatingsFromDB(c.id))).then(function(){
      renderLeaderboardHub(lbHubTab||'all');
    }).catch(function(e){ console.warn('Leaderboard ratings refresh failed:', e); });
  }
}

function switchLbTab(cid){
  lbHubTab=cid;
  document.querySelectorAll('.lb-filter-pill').forEach(function(b){
    b.classList.toggle('active', b.id==='lbt-'+cid);
    b.style.background='';b.style.color='';b.style.borderColor='';
  });
  renderLeaderboardHub(cid);
}

function renderLeaderboardHub(filter){
  var el=$('leaderboard-content');if(!el)return;
  var allPlayers=[];
  var targetClubs=filter==='all'?clubs:clubs.filter(function(cl){return cl.id===filter;});
  targetClubs.forEach(function(club){
    (getData(club.id)||{players:[]}).players.forEach(function(p){
      var r=overallRating(club.id,p.id);
      if(r>0) allPlayers.push({player:p,club:club,rating:r});
    });
  });
  allPlayers.sort(function(a,b){return b.rating-a.rating;});
  if(!allPlayers.length){
    el.innerHTML='<div class="lb-empty"><div class="lb-empty-icon"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#ddd" stroke-width="1.5"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a2 2 0 0 0 0 4h2M17 6h3a2 2 0 0 1 0 4h-2"/></svg></div><div class="lb-empty-title">No ratings yet</div><div class="lb-empty-sub">Rate players after matchdays</div></div>';
    return;
  }
  function medalSvg(i){
    var colors=[['#f1c40f','#d4a800','#7a5c00'],['#c7cdd6','#a4abb6','#555c66'],['#d99a5b','#b97c3e','#5e3c14']];
    if(i>2)return'';
    var col=colors[i];
    return'<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="9" fill="'+col[0]+'"/><circle cx="10" cy="10" r="9" fill="none" stroke="'+col[1]+'" stroke-width=".8"/><text x="10" y="14" text-anchor="middle" font-size="9" font-weight="700" fill="'+col[2]+'" font-family="Oswald,sans-serif">'+(i+1)+'</text></svg>';
  }
  var html='<div class="lb-list">';
  allPlayers.forEach(function(item,i){
    var club=item.club,p=item.player,r=item.rating;
    html+='<div class="lb-row-card'+(i===0?' lb-row-first':'')+'" onclick="openPlayerInfo(\''+p.id+'\',\''+club.id+'\')" style="cursor:pointer">';
    html+='<div class="lb-rank-cell">'+(i<3?medalSvg(i):'<span class="lb-rank-num">'+(i+1)+'</span>')+'</div>';
    html+=avH(p.name,p.img,42,club.primary,club.accent);
    html+='<div class="lb-info"><div class="lb-pname">'+p.name+'</div>';
    html+='<div class="lb-psub">'+p.pos+' &middot; <span style="color:'+club.accent+';font-weight:700">'+club.short+'</span></div>';
    html+='<div class="lb-stars">'+starsH(r,11)+'</div></div>';
    html+='<div class="lb-score-cell"><div class="lb-score-num">'+r.toFixed(1)+'</div><div class="lb-score-max">/5.0</div></div>';
    html+='</div>';
  });
  html+='</div>';
  el.innerHTML=html;
}

let galleryFilter = 'all';
let lightboxIdx = -1;

function openGalleryView(){
  showV('gallery');
  renderGalleryTabs();
  renderGallery();
}
function renderGalleryTabs(){
  const wrap=$('gal-filter-tabs');if(!wrap)return;
  const clubBtns=clubs.map(function(c){
    return '<button class="hub-tab'+(galleryFilter===c.id?' active':'')+'" data-club="'+c.id+'" onclick="setGalleryFilter(\''+c.id+'\')">'+c.short+'</button>';
  }).join('');
  wrap.innerHTML='<button class="hub-tab'+(galleryFilter==='all'?' active':'')+'" data-club="all" onclick="setGalleryFilter(\'all\')">All Photos</button>'+clubBtns;
}

function renderGallery(){
  const grid = $('gallery-grid');
  if(!grid) return;
  const filtered = galleryFilter === 'all'
    ? gallery
    : gallery.filter(g => g.clubId === galleryFilter);

  // Update count
  const countEl = $('gal-count');
  if(countEl) countEl.textContent = filtered.length + (filtered.length === 1 ? ' photo' : ' photos');

  // Update add button visibility
  const galAdminBtn = $('gal-add-btn-wrap');
  if(galAdminBtn) galAdminBtn.style.display = isAdmin ? '' : 'none';

  if(!filtered.length){
    const filterClub = galleryFilter==='all' ? null : getClub(galleryFilter);
    const label = filterClub ? filterClub.short+' photos' : 'photos';
    grid.innerHTML = `<div class="gal-empty">
      <div class="gal-empty-icon">📷</div>
      <div class="gal-empty-text">No ${label} yet</div>
      <div class="gal-empty-sub">${isAdmin ? 'Click + Add Photo to upload the first one' : 'Check back soon!'}</div>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map((item, i) => {
    const club = item.clubId ? getClub(item.clubId) : null;
    return `<div class="gal-item" onclick="openLightbox(${i})">
      <div class="gal-img-wrap">
        <img src="${item.img}" alt="${item.title}" loading="lazy"/>
      </div>
      <div class="gal-overlay"></div>
      <div class="gal-overlay-info">
        ${club ? `<div class="gal-club-badge" style="background:${club.primary};color:${club.accent}">${club.short}</div>` : ''}
        <div class="gal-ov-title" style="margin-top:4px">${item.title}</div>
        <div class="gal-ov-date">${item.date || ''}</div>
      </div>
      ${isAdmin ? `<button class="gal-del" onclick="event.stopPropagation();delGalleryItem('${item.id}')" title="Delete">×</button>` : ''}
    </div>`;
  }).join('');
}

function openLightbox(idx){
  const filtered = galleryFilter === 'all'
    ? gallery
    : gallery.filter(g => g.clubId === galleryFilter);
  if(!filtered.length) return;
  lightboxIdx = idx;
  const item = filtered[idx];
  const club = item.clubId ? getClub(item.clubId) : null;
  $('lb-img').src = item.img;
  $('lb-title').textContent = item.title;
  $('lb-date').textContent = item.date || '';
  $('lb-club').textContent = club ? club.short : '';
  $('lb-club').style.color = club ? club.accent : '#ccc';
  $('lb-counter').textContent = (idx+1) + ' / ' + filtered.length;
  $('lb-prev').style.display = idx > 0 ? '' : 'none';
  $('lb-next').style.display = idx < filtered.length-1 ? '' : 'none';
  openModal('m-lightbox');
}

function lightboxNav(dir){
  const filtered = galleryFilter === 'all'
    ? gallery
    : gallery.filter(g => g.clubId === galleryFilter);
  const newIdx = lightboxIdx + dir;
  if(newIdx >= 0 && newIdx < filtered.length) openLightbox(newIdx);
}

function setGalleryFilter(cid){
  try{
    galleryFilter = cid;
    document.querySelectorAll('#gal-filter-tabs .hub-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.club === cid);
    });
    renderGallery();
  }catch(e){
    console.error('setGalleryFilter error:', e);
    showToast('Filter Error', e.message || 'Could not filter photos.');
  }
}

function openAddPhoto(){
  $('gp-title').value = '';
  $('gp-date').value = new Date().toISOString().split('T')[0];
  $('gp-club').innerHTML = '<option value="all">General (All Clubs)</option>' +
    clubs.map(c=>`<option value="${c.id}">${c.short}</option>`).join('');
  $('gp-club').value = 'all';
  $('gp-preview').innerHTML = '<div style="width:100%;height:160px;background:#f5f5f5;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:13px">No photo selected</div>';
  window._gpFile = null;
  openModal('m-add-photo');
}

function onGpFileSelect(e){
  const file = e.target.files[0]; if(!file) return;
  window._gpFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    $('gp-preview').innerHTML = `<img src="${ev.target.result}" style="width:100%;max-height:220px;object-fit:cover;border-radius:10px;"/>`;
  };
  reader.readAsDataURL(file);
}

async function doAddPhoto(){
  const title = $('gp-title').value.trim();
  const date = $('gp-date').value;
  const clubId2 = $('gp-club').value;
  const file = window._gpFile;
  if(!file){ showToast('Missing','Select a photo file.'); return; }

  let imgUrl;
  try{
    imgUrl = await uploadImageToStorage(file, 'gallery');
  }catch(e){
    showToast('Upload Failed', e.message||'Could not upload photo. Check your connection and try again.');
    return;
  }

  const newItem = {
    id: 'g' + Date.now(),
    title, date,
    clubId: clubId2 === 'all' ? null : clubId2,
    img: imgUrl,
    created: new Date().toISOString()
  };

  if(dbConnected){
    try{
      const dbRow = await dbSaveGalleryItem(newItem);
      if(dbRow){ newItem.id = dbRow.id; }
    } catch(e){ console.warn('Gallery DB save failed:', e.message); showToast('Not Saved', "Photo uploaded but the gallery entry didn't save. Try again."); return; }
  }
  gallery.unshift(newItem);
  sv('uc_gallery_v7', gallery);
  writeLog('photo_uploaded', 'gallery', {details:{title:title||'(untitled)'}});
  cm('m-add-photo');
  renderGallery();
  renderHome(); // refresh home strip
  showToast('Photo Saved', (title||'Photo') + ' saved to gallery.');
}

function delGalleryItem(id){
  if(!requireOwner('Deleting a photo'))return;
  showConfirm('Delete Photo', 'Remove this photo from the gallery?', 'Yes, Delete', async () => {
    if(dbConnected){ await dbDeleteGalleryItemRow(id); }
    gallery = gallery.filter(g => g.id !== id);
    sv('uc_gallery_v7', gallery);
    renderGallery();
    showToast('Photo Deleted', 'Photo removed from gallery.');
  });
}

function openDisciplineModal(){
  const data = getData(clubId);
  const players = data ? data.players : [];
  const opts = players.map(p =>
    `<option value="${p.id}">${p.name} (#${p.num})</option>`
  ).join('');
  $('dc-player').innerHTML = '<option value="">— Select Player —</option>' + opts;
  $('dc-type').value = 'yellow';
  openModal('m-discipline');
}

function doAddCard(){
  const pid = $('dc-player').value;
  const type = $('dc-type').value;
  if(!pid){ showToast('Missing', 'Select a player.'); return; }
  const p = clubData[clubId].players.find(pl => pl.id === pid);
  if(!p) return;
  if(type === 'yellow'){
    p.yellowCards = (p.yellowCards || 0) + 1;
    showToast('🟨 Yellow Card', p.name + ' — yellow card shown.');
  } else {
    p.redCards = (p.redCards || 0) + 1;
    showToast('🟥 Red Card', p.name + ' — red card shown!');
  }
  sv('uc_data_v7', clubData);
  writeLog(type === 'yellow' ? 'yellow_card' : 'red_card', 'matchday', {
    player_id: pid, details: {name: p.name, type}
  });
  cm('m-discipline');
  renderMdPlayers(getClub(clubId), getData(clubId), getData(clubId).matchdays.find(m => m.id === mdId));
  renderPlayers();
}

async function openStandings(cid){
  if(!standings[cid])standings[cid]=[];
  if(dbConnected){ await loadStandingsFromDB(cid); }
  renderStandingsModal(cid);openModal('m-standings');
}
function renderStandingsModal(cid){
  var club=getClub(cid),rows=standings[cid]||[],isNB=isNetball(cid);
  sortStandingsRows(rows,isNB);
  $('standings-title').textContent=(club?club.short:'Club')+' Standings';
  $('standings-club-id').value=cid;
  var hdrs=isNB?['Team','P','W','D','L','F','A','GD','Pts','PCT']:['Team','P','W','D','L','GF','GA','GD','Pts'];
  var acc=club?club.accent:'#4dc8c8',pri=club?club.primary:'#1d2d5a';
  var tableH='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:'+pri+'">'+
    hdrs.map(function(h){return '<th style="padding:8px 10px;text-align:'+(h==='Team'?'left':'center')+';color:'+acc+';font-size:11px;letter-spacing:.5px;white-space:nowrap">'+h+'</th>';}).join('')+
    (isAdmin?'<th></th>':'')+
    '</tr></thead><tbody>';
  rows.forEach(function(row,i){
    var bg=i%2===0?'#f8f9fc':'#fff';
    var pts=isNB?(row.w||0)*2+(row.d||0):(row.w||0)*3+(row.d||0);
    var gd=(row.gf||0)-(row.ga||0);
    var gdStr=(gd>=0?'+':'')+gd;
    var gdCol=gd>=0?'#2ecc71':'#e74c3c';
    var pct=isNB&&(row.p||0)>0?(pts/((row.p||1)*2)).toFixed(3):'';
    var teamSafe=row.team.replace(/'/g,"\\'");
    tableH+='<tr style="background:'+bg+'">'+
      '<td style="padding:8px 10px;font-weight:700;color:#1a1a2e">'+(i+1)+'. '+teamNameLinkH(cid,row.team)+'</td>'+
      '<td style="text-align:center;padding:8px 6px">'+(row.p||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px;color:#2ecc71;font-weight:700">'+(row.w||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px;color:#f39c12">'+(row.d||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px;color:#e74c3c">'+(row.l||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px">'+(row.gf||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px">'+(row.ga||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px;color:'+gdCol+'">'+gdStr+'</td>'+
      '<td style="text-align:center;padding:8px 6px;font-family:Oswald,sans-serif;font-size:16px;font-weight:700;color:'+acc+'">'+pts+'</td>'+
      (isNB?'<td style="text-align:center;padding:8px 6px;color:#999;font-size:11px">'+pct+'</td>':'')+
      (isAdmin?('<td style="text-align:center;padding:4px 6px;white-space:nowrap">'+
        '<button onclick="editStandingRow(\''+cid+'\',\''+teamSafe+'\')" title="Edit row" style="border:none;background:none;cursor:pointer;font-size:14px;padding:2px 4px">&#9998;</button>'+
        '<button onclick="deleteStandingRow(\''+cid+'\',\''+teamSafe+'\')" title="Delete row" style="border:none;background:none;cursor:pointer;font-size:14px;padding:2px 4px;color:#e74c3c">&#128465;</button>'+
        '</td>'):'')+
      '</tr>';
  });
  tableH+='</tbody></table></div>';
  if(!rows.length)tableH='<div style="color:#ccc;font-style:italic;text-align:center;padding:24px">No standings yet. Add rows below.</div>';
  $('standings-table').innerHTML=tableH;
  var formH='';
  if(isAdmin){
    formH='<div style="padding-top:14px;border-top:1.5px solid #eee;margin-top:14px">'+
      '<div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:10px">Add / Update Team <span style="text-transform:none;font-weight:400;color:#bbb">(same name = overwrite that row)</span></div>'+
      '<div style="display:grid;grid-template-columns:2fr repeat(6,1fr);gap:6px">'+
      '<div><label class="flbl">Team Name</label><input id="st-team" class="finp" placeholder="Team name"/></div>'+
      '<div><label class="flbl">P</label><input id="st-p" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">W</label><input id="st-w" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">D</label><input id="st-d" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">L</label><input id="st-l" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">'+(isNB?'F':'GF')+'</label><input id="st-gf" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">'+(isNB?'A':'GA')+'</label><input id="st-ga" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '</div>'+
      '<div style="display:flex;gap:8px;margin-top:10px">'+
      '<button onclick="addStandingRow(\''+cid+'\')" style="padding:8px 18px;border-radius:8px;border:1.5px solid #2ecc71;color:#2ecc71;background:#fff;font-weight:700;font-size:13px;cursor:pointer">+ Add / Update Row</button>'+
      '<button onclick="clearStandings(\''+cid+'\')" style="padding:8px 14px;border-radius:8px;border:1.5px solid #e74c3c;color:#e74c3c;background:#fff;font-weight:700;font-size:13px;cursor:pointer">Clear All</button>'+
      '</div></div>';
  }
  $('standings-form').innerHTML=formH;
}
// Pre-fills the Add/Update form with an existing row's values so admins
// can tweak a single row without retyping everything.
function editStandingRow(cid,team){
  var row=(standings[cid]||[]).find(function(r){return r.team===team;});
  if(!row)return;
  if($('st-team'))$('st-team').value=row.team;
  if($('st-p'))$('st-p').value=row.p||0;
  if($('st-w'))$('st-w').value=row.w||0;
  if($('st-d'))$('st-d').value=row.d||0;
  if($('st-l'))$('st-l').value=row.l||0;
  if($('st-gf'))$('st-gf').value=row.gf||0;
  if($('st-ga'))$('st-ga').value=row.ga||0;
  if($('st-team'))$('st-team').focus();
}
async function deleteStandingRow(cid,team){
  showConfirm('Delete Row','Remove '+team+' from the standings?','Yes, Delete',async function(){
    if(dbConnected){
      await dbDeleteStandingRow(cid,team);
      await loadStandingsFromDB(cid);
    } else {
      standings[cid]=(standings[cid]||[]).filter(function(r){return r.team!==team;});
    }
    sv('uc_standings_v7',standings);
    writeLog('standings_row_deleted','club',{club_id:cid,details:{team:team}});
    renderStandingsModal(cid);showToast('Removed',team+' removed from standings.');
  });
}
async function addStandingRow(cid){
  var team=($('st-team')||{}).value;if(!team||!team.trim()){showToast('Missing','Enter team name.');return;}
  team=team.trim();
  var isNB=isNetball(cid);
  var row={team:team,p:parseInt(($('st-p')||{}).value)||0,w:parseInt(($('st-w')||{}).value)||0,d:parseInt(($('st-d')||{}).value)||0,l:parseInt(($('st-l')||{}).value)||0,gf:parseInt(($('st-gf')||{}).value)||0,ga:parseInt(($('st-ga')||{}).value)||0};
  if((row.w+row.d+row.l)!==row.p){
    showToast('Check Your Numbers',`Played (${row.p}) doesn't match Won+Drawn+Lost (${row.w+row.d+row.l}) for ${team}. Saved anyway — you can edit it.`);
  }
  if(!standings[cid])standings[cid]=[];
  var idx=standings[cid].findIndex(function(r){return r.team===team;});
  if(idx>=0)standings[cid][idx]=row;else standings[cid].push(row);
  standings[cid].sort(function(a,b){
    var pa=isNB?(a.w||0)*2+(a.d||0):(a.w||0)*3+(a.d||0);
    var pb=isNB?(b.w||0)*2+(b.d||0):(b.w||0)*3+(b.d||0);
    return pb-pa;
  });
  if(dbConnected){
    await dbSaveStandingRow(cid,row);
    await loadStandingsFromDB(cid);
    standings[cid]=(standings[cid]||[]).sort(function(a,b){
      var isNB2=isNetball(cid);
      var pa=isNB2?(a.w||0)*2+(a.d||0):(a.w||0)*3+(a.d||0);
      var pb=isNB2?(b.w||0)*2+(b.d||0):(b.w||0)*3+(b.d||0);
      return pb-pa;
    });
  }
  sv('uc_standings_v7',standings);
  writeLog('standings_updated','club',{club_id:cid,details:{team:team}});
  renderStandingsModal(cid);showToast('Updated',team+' row saved.');
}
function clearStandings(cid){
  showConfirm('Clear Standings','Remove all standings rows?','Yes, Clear',async function(){
    if(dbConnected){
      await dbClearStandings(cid);
      await loadStandingsFromDB(cid);
    } else {
      standings[cid]=[];
    }
    sv('uc_standings_v7',standings);renderStandingsModal(cid);
  });
}

async function init(){
  
  const ok = await loadClubsFromDB();
  dbConnected = ok;
  if(dbConnected){
    if(await restoreSession()){
      try{
        const rows = await sb('GET','admin_profiles',{eq:{user_id:supaSession.user_id},select:'*'});
        if(rows && rows.length){
          isAdmin=true;
          currentAdmin={...rows[0], managedClub: rows[0].managed_club};
          updAB();
        } else {
          clearSession();
        }
      }catch(e){ console.warn('Session restore profile fetch failed:', e.message); clearSession(); }
    }
    checkScheduledNotifs();
    
    renderHome();
    reqNotifPerm();
    startHomeLiveClocks();
    initRealtime();

    clubs.forEach(async function(c){
      try{
        await loadClubMatchdaysFromDB(c.id);
        renderHome();
        refreshView();
      }catch(e){ console.warn('Club matchdays load failed for',c.id,e); }
      try{
        await loadClubDataFromDB(c.id);
        renderHome();
        refreshView();
      }catch(e){ console.warn('Club data load failed for',c.id,e); }
      try{
        await loadStandingsFromDB(c.id);
        if(logsHubTab==='standings') renderHubStandings();
      }catch(e){ console.warn('Standings load failed for',c.id,e); }
    });
    loadGalleryFromDB().then(function(){ renderHome(); refreshView(); }).catch(function(e){console.warn('Gallery load failed',e);});
    loadLiveScorersGlobal().then(renderHome).catch(function(e){console.warn('Live scorers load failed',e);});
    loadSettingsFromDB().catch(function(e){console.warn('Settings load failed',e);});
  } else {
    checkScheduledNotifs();
    renderHome();
    reqNotifPerm();
    startHomeLiveClocks();
    initRealtime();
  }
}
init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker registration failed:', e));
  });
}
