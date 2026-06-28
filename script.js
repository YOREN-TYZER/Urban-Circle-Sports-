
// =====================================================================
// SUPABASE CONFIG
// =====================================================================
const SUPA_URL = 'https://nsjncrhwhbtzndhrxavr.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zam5jcmh3aGJ0em5kaHJ4YXZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0Njg2NTksImV4cCI6MjA5NjA0NDY1OX0.arTqEq1L5jkiOI8X09DKXb2kaWsuFTrGZWm4QWxm0gM';

async function sb(method, table, opts={}) {
  const {eq, data, select, order, limit, upsert, neq, in: inFilter} = opts;
  let url = `${SUPA_URL}/rest/v1/${table}`;
  const params = new URLSearchParams();
  if (select) params.set('select', select);
  if (order)  params.set('order', order);
  if (limit)  params.set('limit', String(limit));
  if (eq) Object.entries(eq).forEach(([k,v]) => params.set(k, 'eq.' + v));
  if (neq) Object.entries(neq).forEach(([k,v]) => params.set(k, 'neq.' + v));
  if (inFilter) Object.entries(inFilter).forEach(([k,vals]) => params.set(k, 'in.(' + (vals||[]).join(',') + ')'));
  if (params.toString()) url += '?' + params.toString();
  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + SUPA_KEY,
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
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${res.status} on ${table}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function sbUpload(bucket, filePath, file) {
  const res = await fetch(`${SUPA_URL}/storage/v1/object/${bucket}/${filePath}`, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': file.type,
      'x-upsert': 'true'
    },
    body: file
  });
  if (!res.ok) throw new Error('Upload failed');
  return `${SUPA_URL}/storage/v1/object/public/${bucket}/${filePath}`;
}

// =====================================================================
// SUPABASE DATA LOADERS
// =====================================================================
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

async function loadClubDataFromDB(cid) {
  try {
    const [players, matchdays, headlines] = await Promise.all([
      sb('GET', 'players', {eq: {club_id: cid}, select: '*', order: 'num'}),
      sb('GET', 'matchdays', {eq: {club_id: cid}, select: '*', order: 'created_at.desc'}),
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
    const normMds = (matchdays||[]).map(m => ({
      ...m, id: m.id, _id: m.id,
      date: m.match_date, kickoffTime: m.kickoff_time,
      homeGoals: m.home_goals||0, awayGoals: m.away_goals||0,
      ratingWindowHrs: m.rating_window_hrs||24,
      ratingOpenOverride: m.rating_open_override,
      forceClose: m.force_close||false,
      durationKey: m.duration_key||'90',
      htPaused: m.ht_paused||false,
      htPauseStart: m.ht_pause_start||0,
      htPausedTotal: m.ht_paused_total||0,
      matchStartedAt: m.match_started_at||0,
      currentHalf: m.current_half||1,
      halfStartedAt: m.half_started_at||0
    }));
    clubData[cid] = {players: normPlayers, matchdays: normMds, headlines: headlines||[]};
    sv('uc_data_v7', clubData);
  } catch(e) { console.warn('DB load club data failed:', e.message); }
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
    gallery = rows || [];
    sv('uc_gallery_v7', gallery);
    return true;
  } catch(e) {
    // Fall back to localStorage if table doesn't exist yet
    gallery = ld('uc_gallery_v7', []);
    return false;
  }
}

async function loadAdminsFromDB() {
  try {
    const rows = await sb('GET', 'admins', {select: '*', order: 'created_at'});
    // Store in local cache only (don't expose passwords in DOM)
    dbAdmins = rows || [];
    return true;
  } catch(e) {
    console.warn('Could not load admins from DB:', e.message);
    dbAdmins = [];
    return false;
  }
}

async function loadStandingsFromDB(cid) {
  try {
    const rows = await sb('GET', 'standings', {eq: {club_id: cid}, select: '*', order: 'created_at'});
    if (!standings[cid]) standings[cid] = [];
    standings[cid] = (rows||[]).map(r => ({...r, id: r.id}));
    return true;
  } catch(e) {
    console.warn('Could not load standings:', e.message);
    return false;
  }
}

// Bulk-load scorer rows for every currently-live matchday across all clubs,
// so the home page can show goal scorers on club cards / live list without
// needing to enter the matchday first.
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
      force_close: md.forceClose||false, duration_key: md.durationKey||'90',
      ht_paused: md.htPaused||false, ht_pause_start: md.htPauseStart||null, ht_paused_total: md.htPausedTotal||0,
      match_started_at: md.matchStartedAt||null, current_half: md.currentHalf||1,
      half_started_at: md.halfStartedAt||null
    };
    if (md._dbId) {
      await sb('PATCH', 'matchdays', {eq: {id: md._dbId}, data});
    } else {
      const rows = await sb('POST', 'matchdays', {data});
      const row = Array.isArray(rows) ? rows[0] : rows;
      md._dbId = row?.id;
      return row;
    }
  } catch(e) { console.warn('dbSaveMatchday failed:', e.message); }
}

async function dbDeleteMatchday(dbId) {
  try { await sb('DELETE', 'matchdays', {eq: {id: dbId}}); } catch(e) { console.warn(e.message); }
}

async function dbSaveScorers(cid, mid, sc) {
  try {
    const existing = await sb('GET', 'scorers', {eq: {matchday_id: mid}, select: 'id'});
    const payload = {goals: sc.goals||[], assists: sc.assists||[], cards: sc.cards||[]};
    if (existing && existing.length) {
      await sb('PATCH', 'scorers', {eq: {matchday_id: mid}, data: payload});
    } else {
      await sb('POST', 'scorers', {data: {club_id: cid, matchday_id: mid, ...payload}});
    }
  } catch(e) { console.warn('dbSaveScorers failed:', e.message); }
}

async function dbSaveLineup(cid, mid, lu) {
  try {
    const existing = await sb('GET', 'lineups', {eq: {matchday_id: mid}, select: 'id'});
    const data = {club_id: cid, matchday_id: mid, formation: lu.formation, slots: lu.slots, subs: lu.subs};
    if (existing && existing.length) {
      await sb('PATCH', 'lineups', {eq: {matchday_id: mid}, data});
    } else {
      await sb('POST', 'lineups', {data});
    }
  } catch(e) { console.warn('dbSaveLineup failed:', e.message); }
}

async function dbPostRating(cid, mid, pid, stars) {
  try {
    await sb('POST', 'ratings', {
      data: {club_id: cid, matchday_id: mid, player_id: pid, fan_id: fanId, stars},
      upsert: true
    });
  } catch(e) { console.warn('dbPostRating failed:', e.message); }
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

async function dbSaveHeadline(cid, title, date) {
  try {
    const rows = await sb('POST', 'headlines', {data: {club_id: cid, title, date}});
    return Array.isArray(rows) ? rows[0] : rows;
  } catch(e) { console.warn('dbSaveHeadline failed:', e.message); return null; }
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

async function dbLoginAdmin(username, password) {
  try {
    const rows = await sb('GET', 'admins', {eq: {username, password_hash: password}, select: '*'});
    return (rows && rows.length) ? rows[0] : null;
  } catch(e) { console.warn('dbLoginAdmin failed, checking local:', e.message); return null; }
}

async function dbCreateAdmin(admin) {
  try {
    await sb('POST', 'admins', {data: {
      username: admin.username, password_hash: admin.password,
      name: admin.name, role: admin.role, managed_club: admin.managedClub
    }});
    return true;
  } catch(e) { console.warn('dbCreateAdmin failed:', e.message); return false; }
}

async function dbDeleteAdmin(username) {
  try { await sb('DELETE', 'admins', {eq: {username}}); } catch(e) { console.warn(e.message); }
}

async function dbGetAdmins() {
  try {
    return await sb('GET', 'admins', {select: 'id,username,name,role,managed_club,created_at', order: 'created_at'}) || [];
  } catch(e) { return []; }
}

// Flag: are we connected to DB?
let dbConnected = false;
async function checkDBConnection() {
  try {
    await sb('GET', 'clubs', {select: 'id', limit: 1});
    dbConnected = true;
    console.log('Supabase connected');
  } catch(e) {
    dbConnected = false;
    console.warn('Supabase not available, using localStorage');
  }
}

// =====================================================================
// REALTIME (live sync across every connected device — no reload needed)
// =====================================================================
let supaRT=null;
const RT_TABLES=['matchdays','scorers','clubs','players','gallery','headlines','comments','ratings','standings','admins','settings'];
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
    debounceRT('md_'+cid,async function(){
      await loadClubDataFromDB(cid);
      await loadLiveScorersGlobal();
      checkScheduledNotifs();
      if(clubId===cid&&mdId===row.id){
        const fresh=getData(cid)?.matchdays?.find(m=>m.id===row.id);
        if(fresh){ if(fresh.status==='live') startTimer(fresh); else stopTimer(); }
      }
      refreshAfterRT();
    });
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
    const mid=row.matchday_id;
    if(mid&&clubId&&mdId===mid){
      debounceRT(table+'_'+mid,async function(){ await loadMatchdayDataFromDB(clubId,mdId); refreshAfterRT(); });
    }
  } else if(table==='standings'){
    const cid=row.club_id;if(!cid)return;
    debounceRT('standings_'+cid,async function(){
      await loadStandingsFromDB(cid);
      if($('m-standings')?.classList.contains('open')&&$('standings-club-id')?.value===cid) renderStandingsModal(cid);
      refreshAfterRT();
    });
  } else if(table==='admins'){
    debounceRT('admins',function(){ loadAdminsFromDB(); });
  } else if(table==='settings'){
    if(row.key==='uc_logo'){
      ucLogo=row.value||null;
      if(ucLogo)localStorage.setItem('uc_main_logo',ucLogo);else localStorage.removeItem('uc_main_logo');
      renderBrandLogo();
      refreshAfterRT();
    }
  }
}

// =====================================================================
// CONSTANTS
// =====================================================================
const MASTER_CODE = 'UCS@2025Master';
const MAX_ADMINS = 4;
function getAdmins(){return ld('uc_admins_v7',[])}
function saveAdmins(a){sv('uc_admins_v7',a)}

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

// =====================================================================
// STATE
// =====================================================================
function ld(k,fb){try{return JSON.parse(localStorage.getItem(k))||fb}catch{return fb}}
function sv(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}}
const $ = id=>document.getElementById(id);

let clubs    = ld('uc_clubs_v7',   SEED_CLUBS);
// Ensure Warriors → Gladiators → Titans order
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
let logs     = ld('uc_logs_v7',    []);
let notifSent= ld('uc_notifs_v7',  {});
let ucLogo   = localStorage.getItem('uc_main_logo') || null;

let isAdmin=false,currentAdmin=null,clubId=null,mdId=null,activeTab='players';
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
let newLogoData=undefined,newPicData=undefined,newUcLogoData=undefined;
let piNewPhoto=undefined,viewingPid=null,editMdId=null;
let logsPage=0; const LOGS_PER_PAGE=25;
let fanId=localStorage.getItem('uc_fan')||('fan_'+Math.random().toString(36).slice(2,10));
localStorage.setItem('uc_fan',fanId);
let timerInterval=null,timerMdId=null;
let standings=ld('uc_standings_v7',{warriors:[],gladiators:[],titans:[]});
let gallery=ld('uc_gallery_v7',[]);
let dbAdmins=[];

// =====================================================================
// HELPERS
// =====================================================================
function getClub(id){return clubs.find(c=>c.id===id)}
function getData(id){return clubData[id]}
function isNetball(cid){return getClub(cid||clubId)?.sport==='Netball'}

// =====================================================================
// EXTERNAL LEAGUE LINKS (ujcampusleague.leaguerepublic.com)
// Maps a team name typed into our standings table to that exact team's
// page on the external league site. Falls back to the division's main
// page if a specific team isn't found (e.g. a newly-joined team).
// =====================================================================
const LEAGUE_DIVISION_PAGE = {
  warriors:   'https://ujcampusleague.leaguerepublic.com/fg/1_457102445.html', // Promo League 2026
  gladiators: 'https://ujcampusleague.leaguerepublic.com/fg/1_885235865.html'  // Foundation League Stream A
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
  }
};
// Looks up the best link for a team name typed into our app, with
// case/whitespace-insensitive exact matching, then a loose partial match,
// then the division page as a last resort.
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
// Wraps a team name in a link to its external league page, if one exists
// for that club. Returns plain (escaped) text if the club isn't on that
// external league (e.g. netball).
function teamNameLinkH(clubId,teamName){
  const url=leagueLinkFor(clubId,teamName);
  const safe=(teamName||'').replace(/</g,'&lt;');
  if(!url)return safe;
  return '<a href="'+url+'" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dotted currentColor" onclick="event.stopPropagation()" title="View on UJ Campus League">'+safe+'</a>';
}
function compRating(map){const v=Object.values(map||{});return v.length?Math.min(5,v.reduce((s,r)=>s+r.stars,0)/v.length):0}
function overallRating(cid,pid){return compRating(ratings[cid+'_'+pid]||{})}
function mdRating(cid,mid,pid){return compRating(ratings[cid+'_'+mid+'_'+pid]||{})}
async function rateP(cid,mid,pid,stars){
  ratings[cid+'_'+mid+'_'+pid]={...(ratings[cid+'_'+mid+'_'+pid]||{}),[fanId]:{stars,ts:Date.now()}};
  ratings[cid+'_'+pid]={...(ratings[cid+'_'+pid]||{}),[fanId+'_'+mid]:{stars,ts:Date.now()}};
  sv('uc_ratings_v7',ratings);
  if(dbConnected){ await dbPostRating(cid,mid,pid,stars); }
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
function resetStarsEl(el,cid,mid,pid){const v=mdRating(cid,mid,pid);el.querySelectorAll('.star').forEach((s,i)=>{s.className='star '+(i<Math.round(v)?'on':'off')+' click'})}
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
// Single source of truth for "what should the live clock show right now"
// for a given matchday. Used by the matchday banner, the manage-match
// modal, the home page's Live Now list, and club cards — so they always
// agree. The clock only exists once an admin has actually pressed
// "Go Live" (md.matchStartedAt set) — it never starts itself off the
// scheduled kickoff time.
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
  const halfLabel=isNB?('Quarter '+currentHalf+' of '+dur.halves):('Half '+currentHalf+' of '+dur.halves);
  const breakLabel=isNB
    ?(currentHalf===1?'Q1/Q2 Break':currentHalf===2?'Half Time':currentHalf===3?'Q3/Q4 Break':'Break')
    :'Half Time';
  let timeStr=null;
  if(!paused){
    if(atCap){
      const extra=elapsedInHalf-halfSecs;
      timeStr=Math.floor((cumulativeBase+halfSecs)/60)+'+'+(extra<10?'0':'')+extra+"''";
    } else {
      const cum=cumulativeBase+elapsedInHalf;
      const mm=Math.floor(cum/60),ss=cum%60;
      timeStr=mm+':'+(ss<10?'0':'')+ss;
    }
  }
  const atBreak=!paused&&atCap&&currentHalf<dur.halves;
  const pct=Math.min(100,((cumulativeBase+Math.min(elapsedInHalf,halfSecs))/totalSecs)*100);
  return {running:true,timeStr,halfLabel,breakLabel,paused,atBreak,pct,dur,currentHalf,halfSecs,elapsedInHalf};
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
    return [{key:'goals',lbl:'Goals'},{key:'attempts',lbl:'Attempts'},{key:'assists',lbl:'Assists'},{key:'gp',lbl:'Games'},{key:'intercepts',lbl:'Intercepts'}];
  }
  const cat = posCategory(pos);
  if(cat === 'gk'){
    return [
      {key:'gp',lbl:'Games'},
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
      {key:'gp',lbl:'Games'},
      {key:'goals',lbl:'Goals'},
      {key:'assists',lbl:'Assists'},
      {key:'goalsConceded',lbl:'Conceded'},
      {key:'yellowCards',lbl:'YC'},
      {key:'redCards',lbl:'RC'}
    ];
  }
  // Midfielders / Forwards / Wingers / Strikers
  return [
    {key:'gp',lbl:'Games'},
    {key:'goals',lbl:'Goals'},
    {key:'assists',lbl:'Assists'},
    {key:'yellowCards',lbl:'YC'},
    {key:'redCards',lbl:'RC'}
  ];
}
function computeStatValue(p, f){
  if(f.key === 'cleanSheetPct'){
    const gp = p.gp || 0;
    const cs = p.cleanSheets || 0;
    return gp > 0 ? Math.round((cs/gp)*100) + '%' : '0%';
  }
  return p[f.key] || 0;
}
function statsGridH(p,cid){
  const fields=getStatFields(cid,p.pos);
  const cls=isNetball(cid)?'netball-stats':('football-stats stat-count-'+fields.length);
  return`<div class="pc-stats ${cls}">${fields.map(f=>`<div class="stat-cell"><div class="stat-num">${computeStatValue(p,f)}</div><div class="stat-lbl">${f.lbl}</div></div>`).join('')}</div>`;
}

// =====================================================================
// LOGGING
// =====================================================================
function writeLog(action,category,details={}){
  if(dbConnected){ dbWriteLog(action,category,details||{}); }
  logs.unshift({id:Date.now().toString(),action,category,club_id:details.club_id||clubId||null,matchday_id:details.matchday_id||mdId||null,player_id:details.player_id||null,fan_id:fanId,details,ts:new Date().toISOString()});
  if(logs.length>500)logs=logs.slice(0,500);
  sv('uc_logs_v7',logs);
}

// =====================================================================
// NOTIFICATIONS
// =====================================================================
function reqNotifPerm(){if('Notification'in window&&Notification.permission==='default')Notification.requestPermission()}
function sendNotif(title,body){showToast(title,body);if('Notification'in window&&Notification.permission==='granted'){try{new Notification(title,{body})}catch{}}}
function showToast(title,body){
  const wrap=$('toast-wrap'),el=document.createElement('div');el.className='toast';
  el.innerHTML=`<div class="toast-title">${title}</div><div class="toast-body">${body||''}</div>`;
  wrap.appendChild(el);
  setTimeout(()=>{el.classList.add('removing');setTimeout(()=>el.remove(),300)},4000);
}

// =====================================================================
// RATING WINDOW
// =====================================================================
function kickoffMs(md){if(!md.date)return 0;const t=md.kickoffTime||'00:00';return new Date(md.date+'T'+t).getTime()}
function ratingOpenMs(md){return md.ratingOpenOverride||kickoffMs(md)}
function ratingCloseMs(md){if(md.forceClose)return 0;const o=ratingOpenMs(md);if(!o)return 0;return o+(md.ratingWindowHrs||24)*3600000}
function isRatingOpen(md){
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

// =====================================================================
// LIVE TIMER
// =====================================================================
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

// =====================================================================
// MANAGE MATCH PANEL
// =====================================================================
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

// Pressing "Go Live" in the status row is the ONLY thing that starts the
// match clock — it never starts itself off the scheduled kickoff time.
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
// Shortcut shown inside the clock box itself if the match is already
// marked live but the clock was never started (e.g. data imported some
// other way) — same effect as pressing the "Go Live" status button.
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
    // A regular mid-half pause (e.g. injury stoppage) — just continue the
    // same half from where it was paused.
    md2.htPausedTotal=pausedTotalBefore+justPausedSecs;
  }
  md2.htPaused=false;md2.htPauseStart=0;
  sv('uc_data_v7',clubData);
  if(dbConnected){ await dbSaveMatchday(clubId,{...md2,_dbId:md2._dbId||md2.id}); }
  writeLog('match_resumed','matchday',{matchday_id:mdId2});
  showToast('Match Resumed',wasAtHalfBreak?(dur.sport==='Netball'?('Quarter '+md2.currentHalf+' underway!'):('Half '+md2.currentHalf+' underway!')):'Play resumed!');
  refreshClockUI(md2);
}
// Re-paints whichever live-clock UI is currently on screen for this match
// (the matchday banner and/or the manage-match modal can both be open).
function refreshClockUI(md){
  if(mdId===md.id) updateTimerDisplay(md);
  if($('m-manage-match')?.classList.contains('open')) mmRenderClock(md);
  if(document.getElementById('view-home')?.classList.contains('active')) renderHome();
}

// =====================================================================
// SCHEDULED CHECKS
// =====================================================================
// Thresholds at which fans get a "match starting soon" alert. Each fires
// once per matchday, with the wording generated from the *actual* time
// remaining (not a hardcoded string) — e.g. "in 10 minutes" or "in 1 hour".
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
      // NOTE: matches never auto-flip to 'live' just because the scheduled
      // kickoff time arrived — only an admin pressing "Go Live" does that
      // (see mmSetStatus / goLiveStart). The fan rating window can still
      // open on schedule independently (see isRatingOpen()).
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
setInterval(checkScheduledNotifs,10000);
function updateLiveIndicator(){
  let anyLive=false;
  clubs.forEach(c=>{(getData(c.id)?.matchdays||[]).forEach(m=>{if(m.status==='live')anyLive=true})});
  $('live-pill').style.display=anyLive?'':'none';
}

// Ticks the small clocks shown in the home page's "Live Now" list every
// second, without a full re-render, using the same half-aware clock logic
// as everywhere else (so halftime hides the number and shows the break
// label, and the clock only runs once the match has actually gone live).
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

// =====================================================================
// UC MAIN LOGO
// =====================================================================
function renderBrandLogo(){
  const wrap=$('brand-logo-wrap');
  if(ucLogo)wrap.innerHTML=`<img class="brand-logo" src="${ucLogo}" alt="UC Sports"/>`;
  else wrap.innerHTML=`<div class="brand-logo-placeholder">UC</div>`;
}
function openUcLogoModal(){
  newUcLogoData=undefined;
  const wrap=$('uc-logo-preview-wrap');
  wrap.innerHTML=ucLogo?`<img class="uc-logo-preview" src="${ucLogo}" alt="UC Logo"/>`:`<div class="uc-logo-placeholder">UC</div>`;
  openModal('m-uc-logo');
}
function onUcLogoUpload(e){const file=e.target.files[0];if(!file)return;const r=new FileReader();r.onload=ev=>{newUcLogoData=ev.target.result;$('uc-logo-preview-wrap').innerHTML=`<img class="uc-logo-preview" src="${newUcLogoData}" alt="UC Logo"/>`;};r.readAsDataURL(file);}
function removeUcLogo(){newUcLogoData=null;$('uc-logo-preview-wrap').innerHTML=`<div class="uc-logo-placeholder">UC</div>`;}
async function saveUcLogo(){
  if(newUcLogoData!==undefined){
    ucLogo=newUcLogoData;
    if(ucLogo)localStorage.setItem('uc_main_logo',ucLogo);else localStorage.removeItem('uc_main_logo');
    renderBrandLogo();
    if(dbConnected){ await dbSaveSetting('uc_logo',ucLogo||''); }
  }
  cm('m-uc-logo');showToast('Logo Updated','Main logo saved successfully.');
}

// =====================================================================
// SETTINGS (key/value — currently just the main UC logo, saved to
// Supabase so it shows up the same on every device, not just this browser)
// =====================================================================
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

// =====================================================================
// NAV
// =====================================================================
function showV(id){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));$('view-'+id).classList.add('active')}
function goHome(){clubId=null;mdId=null;stopTimer();$('back-btn').style.display='none';$('hdr-sep').style.display='none';$('hdr-club').style.display='none';document.documentElement.style.removeProperty('--c-accent');document.documentElement.style.removeProperty('--c-primary');showV('home');renderHome();}
function goBack(){if(mdId){mdId=null;stopTimer();showV('club');renderClub();}else goHome();}
async function enterClub(id){
  clubId=id;mdId=null;activeTab='players';const c=getClub(id);
  if(dbConnected){ await loadClubDataFromDB(id); await loadStandingsFromDB(id); }
  document.documentElement.style.setProperty('--c-accent',c.accent);
  document.documentElement.style.setProperty('--c-primary',c.primary);
  $('back-btn').style.display='';$('hdr-sep').style.display='';
  $('hdr-club').textContent=c.short;$('hdr-club').style.display='';
  showV('club');renderClub();
}
async function enterMd(id){
  mdId=id;expPlayer=null;spOpen=true;lpOpen=true;
  if(dbConnected){ await loadMatchdayDataFromDB(clubId, id); }
  showV('matchday');renderMd();reqNotifPerm();
}
// Jump straight to a live match's detail view from the home page —
// no intermediate club-page flash.
async function goToLiveMatch(cid,mid){
  clubId=cid;mdId=mid;activeTab='matchdays';expPlayer=null;spOpen=true;lpOpen=true;
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
function openLogsView(){showV('logs');renderLogs();}

// =====================================================================
// ADMIN
// =====================================================================
function handleAdminClick(){
  if(isAdmin){showConfirm('Logout','Log out of admin mode?','Yes, Logout',function(){isAdmin=false;currentAdmin=null;updAB();refreshView();});}
  else openModal('m-admin');
}
async function doAdminLogin(){
  const uname=($('ap-username')||{}).value?.trim()||'';
  const pass=($('ap')||{}).value?.trim()||'';
  let found=null;

  // Try Supabase DB first
  if(dbConnected){
    found=await dbLoginAdmin(uname,pass);
    if(found){ found.managedClub=found.managed_club; }
  }

  // Fallback to localStorage admins
  if(!found){
    const admins=getAdmins();
    found=admins.find(a=>a.username===uname&&a.password===pass)||null;
  }

  if(found){
    isAdmin=true;currentAdmin=found;cm('m-admin');
    if($('ap'))$('ap').value='';if($('ap-username'))$('ap-username').value='';
    $('ap-err').style.display='none';
    updAB();refreshView();
    writeLog('admin_login','admin',{details:{name:found.name,role:found.role}});
    showToast('Welcome '+found.name,'Logged in as '+(found.role||'Admin'));
  } else {
    $('ap-err').textContent='Incorrect username or password.';$('ap-err').style.display='';
  }
}
async function doCreateAdmin(){
  const masterCode=($('ca-master')||{}).value?.trim()||'';
  if(masterCode!==MASTER_CODE){if($('ca-err')){$('ca-err').textContent='Invalid master code.';$('ca-err').style.display='';}return;}
  const username=($('ca-username')||{}).value?.trim()||'';
  const password=($('ca-password')||{}).value?.trim()||'';
  const name=($('ca-name')||{}).value?.trim()||'';
  const role=($('ca-role')||{}).value||'Club Admin';
  const managedClub=($('ca-club')||{}).value||'all';
  if(!username||!password||!name){if($('ca-err')){$('ca-err').textContent='All fields required.';$('ca-err').style.display='';}return;}
  const admins=getAdmins();
  if(admins.find(a=>a.username===username)){if($('ca-err')){$('ca-err').textContent='Username taken.';$('ca-err').style.display='';}return;}
  var newAdmin={username,password,name,role,managedClub,created:new Date().toISOString()};
  admins.push(newAdmin);saveAdmins(admins);
  if(dbConnected){ await dbCreateAdmin(newAdmin); }
  cm('m-create-admin');
  showToast('Admin Created',name+' can now log in.');
  writeLog('admin_created','admin',{details:{name,role}});
  renderAdminProfiles();
}
async function doDeleteAdmin(username){
  showConfirm('Remove Admin','Remove admin "'+username+'"?','Yes, Remove',async function(){
    var admins=getAdmins().filter(function(a){return a.username!==username;});
    saveAdmins(admins);
    if(dbConnected){await dbDeleteAdmin(username);}
    showToast('Admin Removed',username+' removed.');renderAdminProfiles();
  });
}
async function renderAdminProfiles(){
  if(dbConnected){ dbAdmins=await dbGetAdmins(); }
  var el=$('admin-profiles-list');if(!el)return;
  var admins=dbConnected&&dbAdmins.length?dbAdmins.map(function(a){return{...a,managedClub:a.managed_club};}):getAdmins();
  if(!admins.length){el.innerHTML='<div style="color:#999;font-style:italic;font-size:13px">No admin profiles yet.</div>';return;}
  el.innerHTML=admins.map(function(a){
    var clubName=a.managedClub==='all'?'All Clubs':(getClub(a.managedClub)||{}).short||a.managedClub;
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 13px;background:#f8f9fc;border-radius:9px;border:1.5px solid #e0e4ef;margin-bottom:7px">'+
      '<div style="width:38px;height:38px;border-radius:50%;background:#1d2d5a;color:#4dc8c8;display:flex;align-items:center;justify-content:center;font-family:Oswald,sans-serif;font-size:15px;font-weight:700;flex-shrink:0">'+a.name.split(' ').map(function(w){return w[0]}).join('').slice(0,2).toUpperCase()+'</div>'+
      '<div style="flex:1"><div style="font-weight:700;font-size:14px;color:#1a1a2e">'+a.name+'</div>'+
      '<div style="font-size:11px;color:#999">@'+a.username+' - '+a.role+' - '+clubName+'</div></div>'+
      '<button onclick="doDeleteAdmin(\''+a.username+'\')" style="background:none;border:none;color:#e74c3c;font-size:18px;cursor:pointer;padding:3px">x</button></div>';
  }).join('');
}
function openCreateAdmin(){
  if(!isAdmin||!currentAdmin||currentAdmin.role!=='Platform Owner'){showToast('Access Denied','Only the Platform Owner can manage admin profiles.');return;}
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

// =====================================================================
// HOME
// =====================================================================
function goalIconFor(club){return isNetball(club.id)?'&#9937;':'&#9917;';}
function liveGoalScorersH(club,md,wrapClass){
  const sc=scorers[club.id+'_'+md.id];
  if(!sc||!sc.goals||!sc.goals.length)return'';
  const icon=goalIconFor(club);
  const names=sc.goals.map(g=>`<b>${g.name}</b>${g.minute?" "+g.minute+"'":''}`).join(', ');
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

  // Gallery preview strip — show last 4 photos on home page
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
      previewHTML += '<div onclick="openGalleryView()" style="position:relative;aspect-ratio:1;overflow:hidden;cursor:pointer;background:#f0f0f5"><img src="' + item.img + '" alt="' + item.title + '" style="width:100%;height:100%;object-fit:cover"/>' + overlay + badge + '</div>';
    });
    preview.innerHTML = previewHTML;
  } else if(strip){
    strip.style.display = 'none';
  }

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
  const newsH=headlines.slice(0,2).map(h=>`<div class="news-item" style="border-color:${club.accent}">${h.title}</div>`).join('');
  let lbH='',anyR=false;
  sorted.slice(0,5).forEach((p,i)=>{const r=overallRating(club.id,p.id);if(!r)return;anyR=true;
    lbH+=`<div class="lb-row" style="${i===0?`background:${club.primary}12`:''}">`+
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

// =====================================================================
// CLUB PAGE
// =====================================================================
function renderClub(){
  const club=getClub(clubId),data=getData(clubId);if(!club||!data)return;
  $('club-banner').innerHTML=`<div style="background:${club.primary};border-radius:16px;padding:20px 24px;display:flex;align-items:center;gap:18px;border-bottom:4px solid ${club.accent};position:relative">
    ${logoH(club,76)}<div style="flex:1"><h2>${club.name}</h2><div class="ban-meta" style="color:${club.accent}">${club.sport} &middot; ${data.players.length} Players</div><div class="ban-tag">${club.tagline}</div></div>
    ${isAdmin?`<button id="edit-club-btn" onclick="openEditClub()">&#9999; Edit Club</button>`:''}
  </div>`;
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
    else if(activeTab==='matchdays')h=`<button class="tact-btn" style="border-color:${club.accent};color:${club.accent}" onclick="openAddMd()">+ Add Matchday</button>`;
    else if(activeTab==='news')h=`<button class="tact-btn" style="border-color:#e74c3c;color:#e74c3c" onclick="openAddNews()">+ Add Headline</button>`;
  }
  $('tab-act').innerHTML=h;
}
function renderTabContent(){if(activeTab==='players')renderPlayers();if(activeTab==='matchdays')renderMatchdays();if(activeTab==='news')renderNews();}

function renderPlayers(){
  const club=getClub(clubId),data=getData(clubId),players=data?.players||[];
  if(!players.length){$('players-grid').innerHTML=`<div class="empty-msg">No players yet.</div>`;return;}
  $('players-grid').innerHTML=players.map(p=>pcH(p,club)).join('');
}
function pcH(p,club){
  const r=overallRating(clubId,p.id),hasR=r>0;
  return`<div class="pc ${hasR?'rated':''}" id="pc_${p.id}" onclick="openPlayerInfo('${p.id}')">
    <div class="pc-head" style="background:${club.primary}">
      <div style="position:relative">${avH(p.name,p.img,66,club.primary,club.accent)}
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

function renderMatchdays(){
  const club=getClub(clubId),data=getData(clubId),mds=data?.matchdays||[];
  if(!mds.length){$('matchdays-grid').innerHTML=`<div class="empty-msg">No matchdays yet.</div>`;return;}
  $('matchdays-grid').innerHTML=mds.map(md=>{
    const{fg,bg}=rcol(md.result),key=clubId+'_'+md.id,sc=scorers[key]||{goals:[],assists:[]};
    const isLive=md.status==='live',open=isRatingOpen(md),dur=getDuration(md);
    let sprev='';
    if(sc.goals?.length)sprev+=`<div>&#9917; <span>${sc.goals.map(g=>g.name+(g.minute?"'"+g.minute:'')).join(', ')}</span></div>`;
    if(sc.assists?.length)sprev+=`<div>&#128094; <span>${sc.assists.map(a=>a.name+(a.minute?"'"+a.minute:'')).join(', ')}</span></div>`;
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
  $('news-list').innerHTML=headlines.map(h=>`<div class="news-row">
    <div><div class="nr-title">${h.title}</div><div class="nr-date">${h.date}</div></div>
    ${isAdmin?`<button class="nr-del" onclick="delNews(${h.id})">x</button>`:''}
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

// =====================================================================
// MATCHDAY PAGE
// =====================================================================
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
      ${sc.goals.map(g=>`<span style="font-size:11px;background:rgba(255,255,255,.08);border-radius:6px;padding:3px 8px;color:#ddd">&#9917; ${g.name}${g.minute?"'"+g.minute:''}</span>`).join('')}
      ${(sc.assists||[]).map(a=>`<span style="font-size:11px;background:rgba(255,255,255,.08);border-radius:6px;padding:3px 8px;color:#bbb">&#128094; ${a.name}${a.minute?"'"+a.minute:''}</span>`).join('')}
    </div>`:''}
  </div>`;
  // Rating status bar
  const bar=$('rating-status-bar'),now=Date.now(),openMs=ratingOpenMs(md),closeMs=ratingCloseMs(md);
  bar.style.display='';
  if(md.forceClose||md.status==='finished'){
    bar.style.cssText='display:;border-color:#ddd;background:#f9f9f9;color:#999;padding:11px 14px;border-radius:8px;border:1.5px solid;font-size:13px;font-weight:700;';
    bar.innerHTML=`Ratings closed${md.forceClose?' (force-closed)':' (window ended)'}${isAdmin?`<button onclick="openEditMd('${mdId}')" style="margin-left:10px;padding:3px 10px;border-radius:6px;border:1.5px solid #ddd;background:#fff;font-size:11px;cursor:pointer;color:#888">Reopen</button>`:''}`;
  } else if(open){
    const pct=closeMs?Math.max(0,Math.min(100,((now-openMs)/(closeMs-openMs))*100)):0;
    bar.style.cssText=`display:;border-color:#2ecc71;background:#f0faf4;color:#2ecc71;padding:11px 14px;border-radius:8px;border:1.5px solid;font-size:13px;font-weight:700;`;
    bar.innerHTML=`Ratings OPEN - ${isLive?'Match is live! ':''}${ratingClosesIn(md)}<div style="margin-top:6px;background:#e0f5e9;border-radius:4px;height:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:#2ecc71;border-radius:4px;transition:width .5s"></div></div>`;
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
  renderMdPlayers(club,data,md);
}

function evtIconSvg(type){
  if(type==='goal') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7l3 2-1 3.5h-4L9 9z" fill="currentColor" stroke="none"/></svg>';
  if(type==='assist') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 19l5-5M5 19h5v-5M19 5l-9 9M19 5v5M19 5h-5"/></svg>';
  if(type==='yellow') return '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2" fill="#f1c40f"/></svg>';
  if(type==='red') return '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2" fill="#e74c3c"/></svg>';
  return '';
}
function renderScorers(club,data,md){
  const key=clubId+'_'+md.id,sc=scorers[key]||{goals:[],assists:[],cards:[]},players=data.players||[];
  const isNB=isNetball(clubId);
  const goalLabel=isNB?'Goals':'Goals',assistLabel=isNB?'Assists':'Assists';

  function evtRow(item,type,i){
    return `<div class="se"><span class="se-icon">${evtIconSvg(type)}</span><span class="se-name">${item.name}</span><span class="se-min">${item.minute?"'"+item.minute:''}</span>${isAdmin?`<button class="se-del" onclick="delScorer('${key}','${type==='goal'?'goals':type==='assist'?'assists':'cards'}',${i})">&times;</button>`:''}</div>`;
  }

  const gH=(sc.goals||[]).length?(sc.goals||[]).map((g,i)=>evtRow(g,'goal',i)).join(''):`<div class="no-se">No goals yet</div>`;
  const aH=(sc.assists||[]).length?(sc.assists||[]).map((a,i)=>evtRow(a,'assist',i)).join(''):`<div class="no-se">No assists yet</div>`;
  const cardsArr=sc.cards||[];
  const cH=cardsArr.length?cardsArr.map((cd,i)=>evtRow(cd,cd.type,i)).join(''):`<div class="no-se">No cards yet</div>`;

  const opts=players.map(p=>`<option value="${p.id}">${p.name} (#${p.num})</option>`).join('');

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
          <input id="sc-m" type="number" min="1" max="130" placeholder="Min" class="finp" style="width:68px;flex:none"/>
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
  const pid=$('sc-p').value,min=$('sc-m').value;
  if(!pid){showToast('Select a player','Choose who this event is for.');return;}
  const player=getData(clubId).players.find(p=>p.id===pid);
  const p2=clubData[clubId].players.find(p=>p.id===pid);
  if(!scorers[key])scorers[key]={goals:[],assists:[],cards:[]};
  if(!scorers[key].cards)scorers[key].cards=[];
  const md=clubData[clubId].matchdays.find(function(m){return m.id===mdId;});

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
    await dbSaveScorers(clubId,mdId,scorers[key]);
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
    await dbSaveScorers(clubId,mdId,scorers[key]);
    if(type==='goals' && md){ await dbSaveMatchday(clubId,{...md,_dbId:md._dbId||md.id}); }
  }
  sv('uc_scorers_v7',scorers);sv('uc_data_v7',clubData);
  var md2r2=md;
  renderLiveScorerStrip(getClub(clubId),scorers[key],md2r2&&md2r2.status==='live');
  renderScorers(getClub(clubId),getData(clubId),md2r2);
  renderLineup(getClub(clubId),getData(clubId),md2r2);
  if(type==='goals') renderMd();
}

// =====================================================================
// LINEUP / COURT
// =====================================================================
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
  const lu=lineups[key]||{formation:formList[0]||'',slots:{},subs:[]};
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
      let events='';if(goals)events+=(isNB?'&#9937;':'&#9917;').repeat(Math.min(goals,3));if(assists)events+=(events?' ':'')+'A'.repeat(Math.min(assists,2));
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
  document.querySelectorAll('.slot-sel').forEach(s=>{lu.slots[s.dataset.slot]=s.value;});
  const subInEls=document.querySelectorAll('.sub-in-sel'),subOutEls=document.querySelectorAll('.sub-out-sel'),subMinEls=document.querySelectorAll('.sub-min-inp');
  lu.subs=[];subInEls.forEach((el,i)=>{lu.subs.push({in:el.value,out:subOutEls[i]?.value||'',minute:subMinEls[i]?.value||''});});
  lineups[key]=lu;
  if(dbConnected){ await dbSaveLineup(clubId,mdId,lu); }
  sv('uc_lineups_v7',lineups);
  const md=getData(clubId).matchdays.find(m=>m.id===mdId),club=getClub(clubId);
  renderLineup(club,getData(clubId),md);
  writeLog('lineup_saved','lineup',{matchday_id:mdId,details:{formation:lu.formation}});
  showToast('Lineup Saved',`${club.short} lineup updated!`);
  sendNotif('Lineup Updated',`${club.short} lineup posted for vs ${md.opponent}.`);
}

// =====================================================================
// ELIGIBLE / MD PLAYERS
// =====================================================================
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
  const mr=mdRating(clubId,md.id,p.id),or=overallRating(clubId,p.id),exp=expPlayer===p.id,canRate=open&&eligible;
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
  return`<div class="mp ${exp&&eligible?'exp':''} ${mr>0&&eligible?'rated':''}" id="mp_${p.id}" style="${dimStyle}">
    <div class="mp-main">
      ${avH(p.name,p.img,46,club.primary,club.accent)}
      <div class="mp-info">
        <div class="mp-name">${p.name}</div>
        <div class="mp-meta">#${p.num} - ${p.pos}</div>
        ${canRate?`<div class="rate-row">${starsH(mr,21,true,clubId,md.id,p.id)}<span class="rate-lbl" style="color:${mr>0?club.accent:'#ccc'}">${mr>0?mr.toFixed(1)+' this match':'Tap to rate'}</span></div>`
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
async function postCmt(pid){const md=getData(clubId)?.matchdays?.find(m=>m.id===mdId);if(!md||!isRatingOpen(md))return;const inp=$('ci_'+pid),text=inp?.value?.trim();if(!text)return;const key=clubId+'_'+mdId+'_'+pid;if(!comments[key])comments[key]=[];comments[key].push({id:Date.now().toString(),fanId,text,ts:new Date().toLocaleString()});sv('uc_cmts_v7',comments);writeLog('comment_posted','comment',{player_id:pid,matchday_id:mdId});reRenderMp(pid);}
async function delCmt(pid,cid){if(dbConnected){ await dbDeleteComment(cid); }const key=clubId+'_'+mdId+'_'+pid;if(comments[key])comments[key]=comments[key].filter(c=>c.id!==cid);sv('uc_cmts_v7',comments);writeLog('comment_deleted','comment',{player_id:pid,matchday_id:mdId});reRenderMp(pid);}

// =====================================================================
// LOGS VIEW
// =====================================================================
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

// =====================================================================
// PLAYER INFO MODAL
// =====================================================================
function openPlayerInfo(pid){
  viewingPid=pid;piNewPhoto=undefined;
  const club=getClub(clubId),data=getData(clubId),p=data.players.find(pl=>pl.id===pid);if(!p)return;
  const r=overallRating(clubId,pid),isNB=isNetball(clubId);
  $('pi-modal-title').textContent=p.shirtname||p.name;
  $('pi-header-block').style.background=club.primary;
  $('pi-header-block').innerHTML=`${avH(p.name,p.img,72,club.primary,club.accent)}
    <div><div style="font-family:'Oswald',sans-serif;font-size:20px;color:#fff">${p.name}</div>
      <div style="font-size:13px;font-weight:700;color:${club.accent};margin:3px 0">#${p.num} - ${p.pos}</div>
      ${p.nationality?`<div style="font-size:12px;color:rgba(255,255,255,.6)">${p.nationality}${p.hometown?' - '+p.hometown:''}</div>`:''}
      ${p.age?`<div style="font-size:12px;color:rgba(255,255,255,.6)">Age ${p.age}${p.height?' - '+p.height+' cm':''}</div>`:''}
    </div>`;
  const fields=getStatFields(clubId,p.pos),gridCls=isNB?'netball-grid':'football-grid';
  $('pi-stats-block').innerHTML=`<div class="pi-stat-grid ${gridCls}" style="grid-template-columns:repeat(${isNB?4:3},1fr)">${fields.map(f=>`<div class="pi-stat"><div class="pi-stat-num">${computeStatValue(p,f)}</div><div class="pi-stat-lbl">${f.lbl}</div></div>`).join('')}</div>`;
  let fH='';
  if(r>0)fH+=`<div class="pi-field"><div class="pi-field-lbl">Fan Rating</div><div>${starsH(r,16)} <span style="color:#e8a020;font-weight:700">${r.toFixed(1)} / 5.0</span></div></div>`;
  // All stats summary
  var allStats='';
  if(!isNB){
    if(p.goals)allStats+='<span style="background:#e8f5e9;color:#2ecc71;border:1px solid #a5d6a7;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.goals+' Goals</span>';
    if(p.assists)allStats+='<span style="background:#e3f2fd;color:#1976d2;border:1px solid #90caf9;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.assists+' &#128094; Assists</span>';
    if(p.gp)allStats+='<span style="background:#f3e5f5;color:#7b1fa2;border:1px solid #ce93d8;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.gp+' Games</span>';
    if(p.cleanSheets)allStats+='<span style="background:#e0f7fa;color:#0097a7;border:1px solid #80deea;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.cleanSheets+' CS</span>';
    if(p.yellowCards)allStats+='<span style="background:#fff8e1;color:#f57f17;border:1px solid #ffe082;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px"><span style="display:inline-block;width:9px;height:13px;background:#f1c40f;border-radius:2px;vertical-align:middle;margin-right:3px"></span>'+p.yellowCards+' YC</span>';
    if(p.redCards)allStats+='<span style="background:#fce4ec;color:#c62828;border:1px solid #ef9a9a;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px"><span style="display:inline-block;width:9px;height:13px;background:#e74c3c;border-radius:2px;vertical-align:middle;margin-right:3px"></span>'+p.redCards+' RC</span>';
  } else {
    if(p.goals)allStats+='<span style="background:#e8f5e9;color:#2ecc71;border:1px solid #a5d6a7;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.goals+' Goals</span>';
    if(p.attempts)allStats+='<span style="background:#e3f2fd;color:#1976d2;border:1px solid #90caf9;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.attempts+' Attempts</span>';
    if(p.assists)allStats+='<span style="background:#f3e5f5;color:#7b1fa2;border:1px solid #ce93d8;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.assists+' &#128094; Assists</span>';
    if(p.intercepts)allStats+='<span style="background:#fff3e0;color:#e65100;border:1px solid #ffcc80;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.intercepts+' Intercepts</span>';
    if(p.gp)allStats+='<span style="background:#fce4ec;color:#880e4f;border:1px solid #f48fb1;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;margin:2px">'+p.gp+' Games</span>';
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
function onPlayerEditPhoto(e){const file=e.target.files[0];if(!file)return;const club=getClub(clubId);const r=new FileReader();r.onload=ev=>{piNewPhoto=ev.target.result;$('pi-edit-avatar').innerHTML=`<img src="${piNewPhoto}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid ${club.accent}"/>`;};r.readAsDataURL(file);}
async function savePlayerEdit(){
  const p=clubData[clubId].players.find(pl=>pl.id===viewingPid);if(!p)return;
  const isNB=isNetball(clubId);
  p.name=$('pi-name').value.trim()||p.name;p.num=parseInt($('pi-num').value)||p.num;p.pos=$('pi-pos').value||p.pos;
  p.age=parseInt($('pi-age').value)||0;p.nationality=$('pi-nationality').value.trim();p.hometown=$('pi-hometown').value.trim();p.height=parseInt($('pi-height').value)||0;p.bio=$('pi-bio').value.trim();
  p.shirtname=$('pi-shirtname')?.value.trim()||'';
  if(!isNB)p.foot=$('pi-foot')?.value||'';
  getStatFields(clubId).forEach(f=>{const el=$('pi-stat-'+f.key);if(el)p[f.key]=parseInt(el.value)||0;});
  if(piNewPhoto!==undefined)p.img=piNewPhoto;
  if(dbConnected){
    try { await dbSavePlayer(viewingPid,p); }
    catch(e){ /* error toast already shown by dbSavePlayer */ return; }
  }
  if(dbConnected){
    try{ await dbSavePlayer(viewingPid,p); }
    catch(e){ return; }
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

// =====================================================================
// DELETE RATINGS
// =====================================================================
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

// =====================================================================
// MODALS
// =====================================================================
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
  const club=getClub(clubId);newLogoData=undefined;
  $('ec-name').value=club.name;$('ec-short').value=club.short;$('ec-tag').value=club.tagline;
  ['p','a','h'].forEach((k,i)=>{const col=['primary','accent','highlight'][i];$('ec-'+k+'-c').value=club[col]||'#000';$('ec-'+k+'-h').value=club[col]||'#000';});
  updClubPrev();$('club-logo-pre').innerHTML=`<img class="logo-pre" src="${club.logo||DEF_LOGOS[club.id]||''}"/>`;$('rm-logo-btn').style.display=club.logo?'':'none';openModal('m-club');
}
function onLogoUpload(e){const file=e.target.files[0];if(!file)return;const r=new FileReader();r.onload=ev=>{newLogoData=ev.target.result;$('club-logo-pre').innerHTML=`<img class="logo-pre" src="${newLogoData}"/>`;$('rm-logo-btn').style.display='';};r.readAsDataURL(file);}
function rmLogo(){newLogoData=null;const club=getClub(clubId);$('club-logo-pre').innerHTML=`<img class="logo-pre" src="${DEF_LOGOS[club.id]||''}"/>`;$('rm-logo-btn').style.display='none';}
function syncC(k){const v=$('ec-'+k+'-c').value;$('ec-'+k+'-h').value=v;updClubPrev();}
function syncCH(k){const v=$('ec-'+k+'-h').value;if(/^#[0-9a-fA-F]{6}$/.test(v)){$('ec-'+k+'-c').value=v;updClubPrev();}}
function updClubPrev(){const name=$('ec-name').value||'Club Name',tag=$('ec-tag').value||'Tagline',pri=$('ec-p-h').value||'#1d2d5a',acc=$('ec-a-h').value||'#4dc8c8';const box=$('ec-prev');box.style.background=pri;box.style.borderColor=acc;$('ec-pname').textContent=name;$('ec-ptag').textContent=tag;$('ec-ptag').style.color=acc;}
async function saveClub(){
  const idx=clubs.findIndex(c=>c.id===clubId);if(idx<0)return;
  clubs[idx].name=$('ec-name').value.trim()||clubs[idx].name;clubs[idx].short=$('ec-short').value.trim()||clubs[idx].short;clubs[idx].tagline=$('ec-tag').value.trim();
  clubs[idx].primary=$('ec-p-h').value||clubs[idx].primary;clubs[idx].accent=$('ec-a-h').value||clubs[idx].accent;clubs[idx].highlight=$('ec-h-h').value||clubs[idx].highlight;
  if(newLogoData!==undefined)clubs[idx].logo=newLogoData;
  sv('uc_clubs_v7',clubs);
  if(dbConnected){ await dbSaveClub(clubId,clubs[idx]); }
  document.documentElement.style.setProperty('--c-accent',clubs[idx].accent);document.documentElement.style.setProperty('--c-primary',clubs[idx].primary);$('hdr-club').textContent=clubs[idx].short;
  writeLog('club_updated','club',{});cm('m-club');renderClub();showToast('Club Updated','Club details saved.');
}

function openPp(pid){editingPicPid=pid;newPicData=undefined;const p=getData(clubId).players.find(pl=>pl.id===pid),club=getClub(clubId);$('pp-pre-wrap').innerHTML=p.img?`<img class="pp-pre" src="${p.img}" alt="${p.name}"/>`:`<div class="pp-pre-av" style="border-color:${club.accent};color:${club.accent}">${p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>`;$('rm-pp-btn').style.display=p.img?'':'none';$('pp-file').value='';openModal('m-pp');}
function onPpUpload(e){const file=e.target.files[0];if(!file)return;const r=new FileReader();r.onload=ev=>{newPicData=ev.target.result;$('pp-pre-wrap').innerHTML=`<img class="pp-pre" src="${newPicData}"/>`;$('rm-pp-btn').style.display='';};r.readAsDataURL(file);}
function rmPlayerPic(){newPicData=null;const p=getData(clubId).players.find(pl=>pl.id===editingPicPid),club=getClub(clubId);$('pp-pre-wrap').innerHTML=`<div class="pp-pre-av" style="border-color:${club.accent};color:${club.accent}">${p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>`;$('rm-pp-btn').style.display='none';}
function savePp(){if(newPicData===undefined){cm('m-pp');return;}const p=clubData[clubId].players.find(pl=>pl.id===editingPicPid);if(p)p.img=newPicData;sv('uc_data_v7',clubData);cm('m-pp');renderPlayers();showToast('Photo Updated','Player photo saved.');}

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
  const newMd={id:'md'+Date.now(),label:lbl,opponent:opp,venue,date,kickoffTime:time,result:res,status:'upcoming',homeGoals:0,awayGoals:0,ratingWindowHrs:24,forceClose:false,ratingOpenOverride:null,durationKey:dur,matchStartedAt:0,currentHalf:1,halfStartedAt:0,htPaused:false,htPauseStart:0,htPausedTotal:0};
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
function openEditMd(mid){
  editMdId=mid;const md=getData(clubId).matchdays.find(m=>m.id===mid);
  $('er-lbl').value=md.label||'';$('er-opp').value=md.opponent||'';$('er-venue').value=md.venue||'';
  $('er-date').value=md.date||'';$('er-time').value=md.kickoffTime||'';$('er-status').value=md.status||'upcoming';
  $('er-duration').value=md.durationKey||'90';$('er-v').value=md.result||'';
  $('er-home').value=md.homeGoals||0;$('er-away').value=md.awayGoals||0;
  $('er-window').value=md.ratingWindowHrs||24;$('er-force-close').checked=!!md.forceClose;
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
  md.ratingWindowHrs=parseInt($('er-window').value)||24;md.forceClose=$('er-force-close').checked;md.durationKey=$('er-duration').value||'90';
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

function openAddNews(){$('nh-t').value='';$('nh-d').value=new Date().toISOString().split('T')[0];openModal('m-news');}
async function doAddHeadline(){
  const t=$('nh-t').value.trim(),d=$('nh-d').value;if(!t)return;
  var hId=Date.now();
  if(dbConnected){ var dbH=await dbSaveHeadline(clubId,t,d); if(dbH){hId=dbH.id;} }
  if(!clubData[clubId].headlines)clubData[clubId].headlines=[];
  clubData[clubId].headlines.push({id:hId,title:t,date:d});
  sv('uc_data_v7',clubData);cm('m-news');renderNews();
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
  var goalIcon=isNB?'&#9937;':'&#9917;';
  var h='<div style="display:flex;flex-wrap:wrap;gap:7px;align-items:center">';
  h+='<span style="font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:'+(club?club.primary:'#1d2d5a')+';flex-shrink:0">'+goalIcon+' Scorers</span>';
  goals.forEach(function(g){
    h+='<span style="display:inline-flex;align-items:center;gap:5px;background:'+(club?club.primary:'#1d2d5a')+';color:#fff;border-radius:20px;padding:5px 13px;font-size:13px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.15)">'+
      '<span>'+goalIcon+'</span>'+
      '<span>'+g.name+'</span>'+
      (g.minute?'<span style="color:'+(club?club.accent:'#4dc8c8')+';font-size:11px">'+g.minute+"'</span>":'')+
    '</span>';
  });
  if(assists.length){
    h+='<span style="font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#888;flex-shrink:0;margin-left:4px">&#128094; Assists</span>';
    assists.forEach(function(a){
      h+='<span style="display:inline-flex;align-items:center;gap:5px;background:#f0f0f5;color:#444;border-radius:20px;padding:5px 13px;font-size:12px;font-weight:600;border:1.5px solid #e0e0e8">'+
        '<span>&#128094;</span>'+
        '<span>'+a.name+'</span>'+
        (a.minute?'<span style="color:#f39c12;font-size:11px">'+a.minute+"'</span>":'')+
      '</span>';
    });
  }
  h+='</div>';
  strip.innerHTML=h;
}



// =====================================================================
// LOGS HUB
// =====================================================================
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
    var hdrs=isNB?['Team','P','W','L','GD','Pts']:['Team','P','W','D','L','GD','Pts'];
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
        var pts=isNB?(row.w||0)*4-(row.l||0)*3:(row.w||0)*3+(row.d||0);
        var gd=(row.gf||0)-(row.ga||0);
        var gdStr=(gd>=0?'+':'')+gd;
        html+='<tr>';
        html+='<td>'+( i+1)+'. '+teamNameLinkH(club.id,row.team)+'</td>';
        html+='<td>'+(row.p||0)+'</td>';
        html+='<td style="color:#2ecc71;font-weight:700">'+(row.w||0)+'</td>';
        if(!isNB) html+='<td style="color:#f39c12">'+(row.d||0)+'</td>';
        html+='<td style="color:#e74c3c">'+(row.l||0)+'</td>';
        html+='<td style="color:'+(gd>=0?'#2ecc71':'#e74c3c')+'">'+gdStr+'</td>';
        html+='<td style="font-family:Oswald,sans-serif;font-size:17px;font-weight:700;color:'+club.accent+'">'+pts+'</td>';
        html+='</tr>';
      });
      html+='</tbody></table></div>';
    }
    html+='</div>';
  });
  panel.innerHTML=html||'<div class="standings-no-data">No standings data yet.</div>';
}

function renderHubFixtures(){
  var panel=$('lh-fixtures');if(!panel)return;
  var all=[];
  clubs.forEach(function(club){
    (getData(club.id)||{matchdays:[]}).matchdays.forEach(function(md){
      all.push({club:club,md:md});
    });
  });
  if(!all.length){panel.innerHTML='<div class="standings-no-data">No fixtures yet.</div>';return;}
  var live=[],upcoming=[],finished=[];
  all.forEach(function(item){
    if(item.md.status==='live') live.push(item);
    else if(item.md.status==='finished') finished.push(item);
    else upcoming.push(item);
  });
  function renderGroup(label,items,dotColor){
    if(!items.length)return'';
    var h='<div class="fixture-group-label" style="color:'+dotColor+'"><span style="width:7px;height:7px;border-radius:50%;background:'+dotColor+';display:inline-block"></span>'+label+'</div>';
    items.forEach(function(item){
      var club=item.club,md=item.md;
      var paused=isMatchPaused(md);
      var isLive=md.status==='live';
      h+='<div class="fixture-card'+(isLive?(paused?' paused-f':' live-f'):'')+'">';
      h+='<div style="display:flex;align-items:center;gap:10px">';
      h+='<img src="'+logoSrc(club)+'" style="width:34px;height:34px;object-fit:contain;border-radius:8px;flex-shrink:0"/>';
      h+='<div style="flex:1;min-width:0">';
      h+='<div style="font-family:Oswald,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e">'+club.short+' <span style="color:#ccc;font-size:12px;font-weight:400">vs</span> '+md.opponent+'</div>';
      if(md.venue) h+='<div style="font-size:11px;color:#aaa;margin-top:2px">&#128205; '+md.venue+'</div>';
      if(md.date) h+='<div style="font-size:11px;color:#aaa">&#128197; '+md.date+(md.kickoffTime?' &middot; '+md.kickoffTime:'')+'</div>';
      h+='</div>';
      if(isLive){
        h+='<div style="text-align:center;flex-shrink:0">';
        h+='<div style="font-family:Oswald,sans-serif;font-size:22px;font-weight:700;color:'+(paused?'#f39c12':'#e74c3c')+'">'+(md.homeGoals||0)+' - '+(md.awayGoals||0)+'</div>';
        h+=liveBadgeH(md,'font-size:9px');
        h+='</div>';
      } else if(md.result){
        h+='<div style="font-family:Oswald,sans-serif;font-size:15px;font-weight:700;color:'+club.accent+';flex-shrink:0">'+md.result+'</div>';
      }
      h+='</div>';
      if(isLive){
        var _col2=paused?'#f39c12':'#e74c3c';
      h+='<button data-cid="'+club.id+'" data-mid="'+md.id+'" onclick="var b=this;enterClub(b.dataset.cid);setTimeout(function(){enterMd(b.dataset.mid)},60)" style="width:100%;margin-top:10px;padding:8px;border-radius:8px;border:1.5px solid '+_col2+';background:#fff;color:'+_col2+';font-weight:700;font-size:12px;cursor:pointer">View Match &rarr;</button>';
      }
      h+='</div>';
    });
    return h;
  }
  var html='';
  html+=renderGroup('Live Now',live,'#e74c3c');
  html+=renderGroup('Upcoming',upcoming,'#4dc8c8');
  html+=renderGroup('Results',finished,'#aaa');
  panel.innerHTML=html;
}

function renderHubStats(){
  var panel=$('lh-stats');if(!panel)return;
  var statGroups=[
    {key:'goals',label:'Top Scorers',color:'#2ecc71',icon:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/></svg>'},
    {key:'assists',label:'Top Assists',color:'#3d7dd4',icon:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 19l5-5M5 19h5v-5"/><path d="M19 5l-9 9"/></svg>'},
    {key:'yellowCards',label:'Yellow Cards',color:'#f1c40f',icon:'<svg viewBox="0 0 24 24" width="14" height="16"><rect x="5" y="2" width="14" height="20" rx="2" fill="#f1c40f"/></svg>'},
    {key:'redCards',label:'Red Cards',color:'#e74c3c',icon:'<svg viewBox="0 0 24 24" width="14" height="16"><rect x="5" y="2" width="14" height="20" rx="2" fill="#e74c3c"/></svg>'},
    {key:'cleanSheets',label:'Clean Sheets',color:'#4dc8c8',icon:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#4dc8c8" stroke-width="2"><path d="M20 7L9 18l-5-5"/></svg>'},
  ];
  var html='';
  statGroups.forEach(function(sg){
    var allPlayers=[];
    clubs.forEach(function(club){
      (getData(club.id)||{players:[]}).players.forEach(function(p){
        if((p[sg.key]||0)>0) allPlayers.push({player:p,club:club,val:p[sg.key]||0});
      });
    });
    if(!allPlayers.length)return;
    allPlayers.sort(function(a,b){return b.val-a.val;});
    var top=allPlayers.slice(0,5);
    html+='<div class="stat-section">';
    html+='<div class="stat-section-title" style="color:'+sg.color+'">'+sg.icon+' '+sg.label+'</div>';
    top.forEach(function(item,i){
      var rClass=i===0?'r1':i===1?'r2':i===2?'r3':'rN';
      var rankLabel=i===0?'1':i===1?'2':i===2?'3':(i+1)+'';
      html+='<div class="stat-rank-item">';
      html+='<div class="stat-rank-n '+rClass+'">'+rankLabel+'</div>';
      html+=avH(item.player.name,item.player.img,40,item.club.primary,item.club.accent);
      html+='<div class="stat-rank-info"><div class="stat-rank-name">'+item.player.name+'</div><div class="stat-rank-sub">'+item.player.pos+' &middot; <span style="color:'+item.club.accent+';font-weight:700">'+item.club.short+'</span></div></div>';
      html+='<div class="stat-rank-val" style="color:'+sg.color+'">'+item.val+'</div>';
      html+='</div>';
    });
    html+='</div>';
  });
  panel.innerHTML=html||'<div class="standings-no-data">No stats logged yet.</div>';
}

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
      sc.goals.forEach(function(g){
        html+='<span style="background:'+club.primary+';color:#fff;border-radius:50px;padding:3px 10px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>'+g.name+(g.minute?"'"+g.minute:'')+'</span>';
      });
      (sc.assists||[]).forEach(function(a){
        html+='<span style="background:#f0f2f7;color:#555;border-radius:50px;padding:3px 10px;font-size:11px;font-weight:600;border:1px solid #e0e4ef">A '+a.name+(a.minute?"'"+a.minute:'')+'</span>';
      });
      html+='</div>';
    }
    var _lc=paused?'#f39c12':'#e74c3c';
    html+='<button data-cid="'+club.id+'" data-mid="'+md.id+'" onclick="var b=this;enterClub(b.dataset.cid);setTimeout(function(){enterMd(b.dataset.mid)},60)" style="width:100%;padding:9px;border-radius:9px;border:1.5px solid '+_lc+';background:#fff;color:'+_lc+';font-weight:700;font-size:13px;cursor:pointer">View Live Match &rarr;</button>';
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
    headlines.slice(0,5).forEach(function(h){
      html+='<div class="news-card" data-cid="'+cid+'" onclick="enterClub(this.dataset.cid);switchTab(String.fromCharCode(110,101,119,115))">';
      html+='<div class="news-card-title">'+h.title+'</div>';
      html+='<div class="news-card-meta"><span style="color:'+club.accent+';font-weight:700">'+club.short+'</span> &bull; '+( h.date||'')+'</div>';
      html+='</div>';
    });
    html+='<button class="news-see-more" data-cid="'+cid+'" onclick="enterClub(this.dataset.cid);switchTab(String.fromCharCode(110,101,119,115))" style="color:'+club.accent+'">';
    html+='All '+club.short+' news <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
    html+='</button>';
    html+='</div>';
  });
  el.innerHTML=html||'<div class="standings-no-data" style="padding:60px">No news posted yet.</div>';
}

// =====================================================================
// LEADERBOARD HUB
// =====================================================================
function openLeaderboardHub(){
  showV('leaderboard');
  renderLeaderboardHub('all');
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
    html+='<div class="lb-row-card'+(i===0?' lb-row-first':'')+'">';
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

// =====================================================================
// GALLERY
// =====================================================================
let galleryFilter = 'all';
let lightboxIdx = -1;

function openGalleryView(){
  showV('gallery');
  renderGallery();
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
    grid.innerHTML = `<div class="gal-empty">
      <div class="gal-empty-icon">📷</div>
      <div class="gal-empty-text">${isAdmin ? 'No photos yet' : 'No photos yet'}</div>
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
  galleryFilter = cid;
  document.querySelectorAll('#gal-filter-tabs .hub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.club === cid);
  });
  renderGallery();
}

function openAddPhoto(){
  $('gp-title').value = '';
  $('gp-date').value = new Date().toISOString().split('T')[0];
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
  if(!title){ showToast('Missing','Enter a photo title.'); return; }
  if(!file){ showToast('Missing','Select a photo file.'); return; }

  const reader = new FileReader();
  reader.onload = async ev => {
    const base64 = ev.target.result;
    const newItem = {
      id: 'g' + Date.now(),
      title, date,
      clubId: clubId2 === 'all' ? null : clubId2,
      img: base64,
      created: new Date().toISOString()
    };
    // Save to Supabase first
    if(dbConnected){
      try{
        const dbRow = await dbSaveGalleryItem(newItem);
        if(dbRow){ newItem.id = dbRow.id; }
      } catch(e){ console.warn('Gallery DB save failed:', e.message); }
    }
    gallery.unshift(newItem);
    sv('uc_gallery_v7', gallery);
    writeLog('photo_uploaded', 'gallery', {details:{title}});
    cm('m-add-photo');
    renderGallery();
    renderHome(); // refresh home strip
    showToast('Photo Saved', title + ' saved to gallery.');
  };
  reader.readAsDataURL(file);
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


// =====================================================================
// LIVE DISCIPLINE (Yellow/Red Cards)
// =====================================================================
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

// =====================================================================
// STANDINGS
// =====================================================================
function openStandings(cid){
  if(!standings[cid])standings[cid]=[];
  renderStandingsModal(cid);openModal('m-standings');
}
function renderStandingsModal(cid){
  var club=getClub(cid),rows=standings[cid]||[],isNB=isNetball(cid);
  $('standings-title').textContent=(club?club.short:'Club')+' Standings';
  $('standings-club-id').value=cid;
  var hdrs=isNB?['Team','P','W','L','GF','GA','GD','Pts']:['Team','P','W','D','L','GF','GA','GD','Pts'];
  var acc=club?club.accent:'#4dc8c8',pri=club?club.primary:'#1d2d5a';
  var tableH='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:'+pri+'">'+
    hdrs.map(function(h){return '<th style="padding:8px 10px;text-align:'+(h==='Team'?'left':'center')+';color:'+acc+';font-size:11px;letter-spacing:.5px;white-space:nowrap">'+h+'</th>';}).join('')+
    (isAdmin?'<th></th>':'')+
    '</tr></thead><tbody>';
  rows.forEach(function(row,i){
    var bg=i%2===0?'#f8f9fc':'#fff';
    var pts=isNB?(row.w||0)*4-(row.l||0)*3:(row.w||0)*3+(row.d||0);
    var gd=(row.gf||0)-(row.ga||0);
    var gdStr=(gd>=0?'+':'')+gd;
    var gdCol=gd>=0?'#2ecc71':'#e74c3c';
    var teamSafe=row.team.replace(/'/g,"\\'");
    tableH+='<tr style="background:'+bg+'">'+
      '<td style="padding:8px 10px;font-weight:700;color:#1a1a2e">'+(i+1)+'. '+teamNameLinkH(cid,row.team)+'</td>'+
      '<td style="text-align:center;padding:8px 6px">'+(row.p||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px;color:#2ecc71;font-weight:700">'+(row.w||0)+'</td>'+
      (isNB?'':'<td style="text-align:center;padding:8px 6px;color:#f39c12">'+(row.d||0)+'</td>')+
      '<td style="text-align:center;padding:8px 6px;color:#e74c3c">'+(row.l||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px">'+(row.gf||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px">'+(row.ga||0)+'</td>'+
      '<td style="text-align:center;padding:8px 6px;color:'+gdCol+'">'+gdStr+'</td>'+
      '<td style="text-align:center;padding:8px 6px;font-family:Oswald,sans-serif;font-size:16px;font-weight:700;color:'+acc+'">'+pts+'</td>'+
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
      '<div style="display:grid;grid-template-columns:2fr repeat('+(isNB?5:6)+',1fr);gap:6px">'+
      '<div><label class="flbl">Team Name</label><input id="st-team" class="finp" placeholder="Team name"/></div>'+
      '<div><label class="flbl">P</label><input id="st-p" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">W</label><input id="st-w" type="number" class="finp" min="0" placeholder="0"/></div>'+
      (isNB?'':'<div><label class="flbl">D</label><input id="st-d" type="number" class="finp" min="0" placeholder="0"/></div>')+
      '<div><label class="flbl">L</label><input id="st-l" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">GF</label><input id="st-gf" type="number" class="finp" min="0" placeholder="0"/></div>'+
      '<div><label class="flbl">GA</label><input id="st-ga" type="number" class="finp" min="0" placeholder="0"/></div>'+
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
    standings[cid]=(standings[cid]||[]).filter(function(r){return r.team!==team;});
    sv('uc_standings_v7',standings);
    if(dbConnected){ await dbDeleteStandingRow(cid,team); }
    writeLog('standings_row_deleted','club',{club_id:cid,details:{team:team}});
    renderStandingsModal(cid);showToast('Removed',team+' removed from standings.');
  });
}
async function addStandingRow(cid){
  var team=($('st-team')||{}).value;if(!team||!team.trim()){showToast('Missing','Enter team name.');return;}
  team=team.trim();
  var isNB=isNetball(cid);
  var row={team:team,p:parseInt(($('st-p')||{}).value)||0,w:parseInt(($('st-w')||{}).value)||0,l:parseInt(($('st-l')||{}).value)||0,gf:parseInt(($('st-gf')||{}).value)||0,ga:parseInt(($('st-ga')||{}).value)||0};
  if(!isNB)row.d=parseInt(($('st-d')||{}).value)||0;
  if(!standings[cid])standings[cid]=[];
  var idx=standings[cid].findIndex(function(r){return r.team===team;});
  if(idx>=0)standings[cid][idx]=row;else standings[cid].push(row);
  standings[cid].sort(function(a,b){
    var pa=isNB?(a.w||0)*4-(a.l||0)*3:(a.w||0)*3+(a.d||0);
    var pb=isNB?(b.w||0)*4-(b.l||0)*3:(b.w||0)*3+(b.d||0);
    return pb-pa;
  });
  if(dbConnected){ await dbSaveStandingRow(cid,row); }
  sv('uc_standings_v7',standings);writeLog('standings_updated','club',{club_id:cid,details:{team:team}});
  renderStandingsModal(cid);showToast('Updated',team+' row saved.');
}
function clearStandings(cid){
  showConfirm('Clear Standings','Remove all standings rows?','Yes, Clear',async function(){
    if(dbConnected){ await dbClearStandings(cid); }
    standings[cid]=[];sv('uc_standings_v7',standings);renderStandingsModal(cid);
  });
}

// =====================================================================
// INIT
// =====================================================================
async function init(){
  // Silent DB connection — no loading toast shown to users
  await checkDBConnection();
  if(dbConnected){
    await loadClubsFromDB();
    // Load every club's players/matchdays/headlines up front (not just the
    // locally-cached copy) so the home page's live status, scores, and
    // goal scorers are accurate from Supabase the moment the app opens —
    // on any device, not just the one that made the change.
    await Promise.all(clubs.map(c=>loadClubDataFromDB(c.id)));
    await loadGalleryFromDB();
    await loadLiveScorersGlobal();
    await loadSettingsFromDB();
  }
  checkScheduledNotifs();
  renderHome();
  reqNotifPerm();
  startHomeLiveClocks();
  initRealtime();
}
init();
