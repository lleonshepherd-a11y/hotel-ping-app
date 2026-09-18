(function(){
"use strict";
var __perfT0 = performance.now();
console.log("[PERF] script-start", __perfT0.toFixed(1) + "ms since navigation");
function perfLogAfterPaint(label, since){
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      var now = performance.now();
      console.log("[PERF] " + label, (now - since).toFixed(1) + "ms (elapsed since navigation: " + now.toFixed(1) + "ms)");
    });
  });
}

var ICONS = {
  gm: '<path d="M12 3l7 7-7 11-7-11z"/>',
  foh: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/>',
  concierge: '<path d="M4 16a8 8 0 0 1 16 0"/><path d="M3 16h18"/><circle cx="12" cy="7" r="1.9" fill="currentColor" stroke="none"/>',
  restaurant: '<path d="M7 2v6a1 1 0 0 0 2 0V2"/><path d="M9 2v6a1 1 0 0 0 2 0V2"/><path d="M9 8v13"/><path d="M15 2c-1.5 0-2.5 1.6-2.5 4.2S13.5 10 15 10"/><path d="M15 2v19"/>',
  kitchen: '<path d="M7 18v-3.2c0-.5-.3-.9-.7-1.1a3.5 3.5 0 0 1 1.4-6.4 4.5 4.5 0 0 1 8.6 0 3.5 3.5 0 0 1 1.4 6.4c-.4.2-.7.6-.7 1.1V18"/><path d="M6 18h12"/>',
  bar: '<path d="M4 4h16l-8 9v7"/><path d="M8 20h8"/>',
  housekeeping: '<path d="M3 18v-5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M11 15v-2a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v5"/><path d="M3 18h18"/><path d="M3 18v2"/><path d="M21 18v2"/>',
  maintenance: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  dashboard: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'
};
function iconSvg(deptId){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+ICONS[deptId]+'</svg>';
}
function shadeColor(hex, pct){
  var n = parseInt(hex.slice(1), 16);
  var r = Math.max(0, Math.min(255, ((n>>16)&255) + Math.round(255*pct/100)));
  var g = Math.max(0, Math.min(255, ((n>>8)&255) + Math.round(255*pct/100)));
  var b = Math.max(0, Math.min(255, (n&255) + Math.round(255*pct/100)));
  return "#" + (0x1000000 + r*0x10000 + g*0x100 + b).toString(16).slice(1);
}
function avatarGradient(deptId){
  return "linear-gradient(155deg, #2c2c30, #131315)";
}
function avatarStyleAttr(deptId){
  return "position:relative;background:"+avatarGradient(deptId);
}
function avatarInnerHtml(deptId){
  var meta = DEPT_META[deptId];
  var icon = iconSvg(deptId);
  // The icon always renders first so it's the visible fallback the instant
  // the avatar paints, and stays the fallback if the photo ever fails to
  // load. The photo, when it loads, is a separate opaque <img> painted on
  // top (later in DOM order) that fully covers the icon underneath - so
  // there's never a gap where the circle is blank/flat.
  if(meta && meta.photoUrl){
    return icon + '<img src="'+esc(meta.photoUrl)+'" alt="" class="avatar-photo-img" onerror="this.remove()">';
  }
  return icon;
}

var DEPTS = {
  gm:           { name:"General Manager",          initials:"GM", color:"#a3854f" },
  foh:          { name:"Head Receptionist",   initials:"HR", color:"#4c6f92" },
  concierge:    { name:"Head Concierge",           initials:"CN", color:"#7c62a8" },
  restaurant:   { name:"Restaurant Manager",       initials:"RM", color:"#b16a3f" },
  kitchen:      { name:"Head Chef",                initials:"HC", color:"#c95a2c" },
  bar:          { name:"Bar Manager",              initials:"BM", color:"#3f9d6c" },
  housekeeping: { name:"Head Housekeeper",         initials:"HH", color:"#2f9aa0" },
  maintenance:  { name:"Maintenance Manager",      initials:"MM", color:"#6c6d78" },
  dashboard:    { name:"Head Office",              initials:"HO", color:"#555b66" }
};
var DEPT_ORDER = ["gm","foh","concierge","restaurant","kitchen","bar","housekeeping","maintenance"];

// Real per-department state (contact name, on-duty flag) - loaded from the
// server on boot and kept in sync with it, not held only in memory.
var DEPT_META = {};

var PROFANITY_LIST = [
  "fuck","fucking","fucker","shit","bullshit","bitch","bastard","cunt","dick","dickhead",
  "piss","pissed","asshole","arse","arsehole","crap","wanker","bollocks","twat","prick",
  "slut","whore","damn","goddamn","douche","douchebag","motherfucker","bloody hell"
];
var PROFANITY_PATTERNS = PROFANITY_LIST.map(function(w){
  var escaped = w.replace(/[- \/\\^$*+?.()|[\]{}]/g, "\\$&");
  var exact = new RegExp("[^a-z]" + escaped + "[^a-z]", "i");
  var obfuscated = null;
  if(w.indexOf(" ") === -1 && w.length >= 3){
    var chars = w.split("");
    var parts = chars.map(function(c, i){
      return (i === 0 || i === chars.length - 1) ? c : "(?:" + c + "|[^a-z0-9])";
    });
    obfuscated = new RegExp("[^a-z]" + parts.join("") + "[^a-z]", "i");
  }
  return { exact: exact, obfuscated: obfuscated };
});

function containsProfanity(text){
  var lower = " " + text.toLowerCase() + " ";
  var collapsed = " " + text.toLowerCase().replace(/([a-z])\1{2,}/g, "$1") + " ";
  return PROFANITY_PATTERNS.some(function(p){
    if(p.exact.test(lower) || p.exact.test(collapsed)) return true;
    if(p.obfuscated && p.obfuscated.test(lower)) return true;
    return false;
  });
}

var now = Date.now();

var STATE = {
  self: "foh",
  active: null,
  data: {},        // { deptId: [messages] }, populated from the real server
  attachment: null,
  voice: null,
  composer: "idle",
  recTimerId: null,
  recStart: 0,
  mediaRecorder: null,
  recChunks: [],
  recStream: null,
  synthCleanup: null,
  searchTerm: "",
  loading: false,
  typingFrom: {},
  replyingTo: null,
  muted: {},
  threadOpened: false
};

/* ---------------- Real backend client ---------------- */
var AUTH = { token: null, staff: null };
function authHeaders(extra){
  var h = Object.assign({}, extra || {});
  if(AUTH.token) h['Authorization'] = 'Bearer ' + AUTH.token;
  return h;
}
function apiGet(path){
  return fetch(path, { headers: authHeaders() }).then(function(r){ return r.json().then(function(body){ return r.ok ? body : Promise.reject(new Error(body.error || 'Request failed')); }); });
}
function apiSend(path, method, body){
  return fetch(path, { method: method, headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify(body) })
    .then(function(r){ return r.json().then(function(json){ return r.ok ? json : Promise.reject(new Error(json.error || 'Request failed')); }); });
}
function apiDelete(path){
  return fetch(path, { method: 'DELETE', headers: authHeaders() })
    .then(function(r){ return r.json().then(function(json){ return r.ok ? json : Promise.reject(new Error(json.error || 'Request failed')); }); });
}
function blobToBase64(blob){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(){ resolve(String(reader.result).split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function mapServerMessage(row, self){
  return {
    id: row.id,
    from: row.from === self ? "self" : row.from,
    to: row.to,
    type: row.type,
    text: row.body || "",
    urgent: !!row.urgent,
    t: new Date(row.createdAt).getTime(),
    read: row.status === "read",
    status: row.status,
    dataUrl: row.type === "image" ? row.fileUrl : undefined,
    url: row.fileUrl || undefined,
    fileName: row.fileName || undefined,
    fileSize: row.fileSize || undefined,
    duration: row.duration || undefined,
    transcript: row.transcript || undefined,
    deleted: !!row.deleted,
    deletedAt: row.deletedAt ? new Date(row.deletedAt).getTime() : undefined,
    replyTo: row.replyTo || undefined,
    pinned: !!row.pinned,
    completed: !!row.completed,
    completedAt: row.completedAt ? new Date(row.completedAt).getTime() : undefined,
    completedBy: row.completedBy || undefined,
    broadcastId: row.broadcastId || undefined,
    roomNumber: row.roomNumber || undefined,
    taskStatus: row.taskStatus || undefined,
    edited: !!row.editedAt,
    mentions: row.mentions || undefined,
    signoff: row.signoff || undefined,
    poll: row.poll || undefined,
    escalationLevel: row.escalationLevel || 0,
    affectsGuest: !!row.affectsGuest
  };
}

function loadDepartmentMeta(){
  return apiGet('/api/departments').then(function(res){
    res.departments.forEach(function(d){ DEPT_META[d.id] = d; });
  });
}

var STAFF_BY_DEPT = {};
function loadStaffMeta(){
  return apiGet('/api/staff').then(function(res){
    STAFF_BY_DEPT = {};
    res.staff.forEach(function(s){
      if(!STAFF_BY_DEPT[s.departmentId]) STAFF_BY_DEPT[s.departmentId] = [];
      STAFF_BY_DEPT[s.departmentId].push(s);
    });
  }).catch(function(){});
}

function buildData(self){
  // "dashboard" isn't a real staff department (no PIN login, on-duty toggle,
  // etc.), so it deliberately stays out of DEPT_ORDER - which drives a lot of
  // unrelated pickers (station assignment, blocker "waiting on", and so on)
  // where it wouldn't make sense to offer. It's added here only, so it shows
  // up as an ordinary conversation in the main chat list.
  var others = DEPT_ORDER.filter(function(id){ return id !== self; });
  // Only the GM bridges both systems (app + dashboard) - every other
  // department reaches head office by messaging the GM directly instead.
  if(self === "gm") others = others.concat(["dashboard"]);
  return Promise.all(others.map(function(id){
    return apiGet('/api/messages?self=' + encodeURIComponent(self) + '&with=' + encodeURIComponent(id))
      .then(function(res){ return { id: id, messages: res.messages.map(function(row){ return mapServerMessage(row, self); }) }; });
  })).then(function(results){
    var data = {};
    results.forEach(function(r){ data[r.id] = r.messages; });
    return data;
  });
}

function fmtClock(ts){
  return new Date(ts).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
}
function fmtRelative(ts){
  var diff = Math.max(0, Math.round((now - ts)/60000));
  if(diff < 1) return "now";
  if(diff < 60) return diff + "m";
  var h = Math.round(diff/60);
  if(h < 24) return h + "h";
  return Math.round(h/24) + "d";
}
function fmtBytes(n){
  if(n < 1024) return n + " B";
  if(n < 1024*1024) return Math.round(n/1024) + " KB";
  return (n/1024/1024).toFixed(1) + " MB";
}
function lastOf(arr){ return arr && arr.length ? arr[arr.length-1] : null; }
function esc(s){ return (s||"").replace(/[&<>]/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];}); }
function highlightMentions(text, mentions){
  var escaped = esc(text);
  mentions.forEach(function(deptId){
    var name = DEPTS[deptId] ? DEPTS[deptId].name : deptId;
    var re = new RegExp("@" + esc(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    escaped = escaped.replace(re, '<span class="mention-tag">@' + esc(name) + '</span>');
  });
  return escaped;
}

var cachedVoice = null;
function pickBestVoice(){
  if(!window.speechSynthesis) return null;
  var voices = window.speechSynthesis.getVoices();
  if(!voices.length) return null;
  var preferred = [
    /Google UK English Female/i, /Google US English/i, /Samantha/i, /Karen/i, /Daniel/i,
    /Enhanced/i, /Premium/i, /Natural/i
  ];
  for(var i=0;i<preferred.length;i++){
    var match = voices.filter(function(v){ return preferred[i].test(v.name) && v.lang.indexOf("en") === 0; })[0];
    if(match) return match;
  }
  var enVoice = voices.filter(function(v){ return v.lang.indexOf("en") === 0; })[0];
  return enVoice || voices[0];
}
function speakText(text){
  if(!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  var utter = new SpeechSynthesisUtterance(text);
  var voice = cachedVoice || pickBestVoice();
  if(voice){ utter.voice = voice; cachedVoice = voice; }
  utter.rate = 0.98;
  utter.pitch = 1;
  window.speechSynthesis.speak(utter);
}
if(window.speechSynthesis){
  window.speechSynthesis.addEventListener("voiceschanged", function(){ cachedVoice = pickBestVoice(); });
}

/* ---------------- Audio helpers ---------------- */
function floatTo16BitPCM(view, offset, input){
  for(var i=0;i<input.length;i++,offset+=2){
    var s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s<0 ? s*0x8000 : s*0x7FFF, true);
  }
}
function encodeWAV(samples, sampleRate){
  var buffer = new ArrayBuffer(44 + samples.length*2);
  var view = new DataView(buffer);
  function ws(o,s){ for(var i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); }
  ws(0,"RIFF"); view.setUint32(4, 36+samples.length*2, true); ws(8,"WAVE");
  ws(12,"fmt "); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  ws(36,"data"); view.setUint32(40, samples.length*2, true);
  floatTo16BitPCM(view, 44, samples);
  return new Blob([view], {type:"audio/wav"});
}
function makeToneVoiceNote(durationSec, baseFreq){
  durationSec = durationSec || 4; baseFreq = baseFreq || 210;
  var sampleRate = 22050;
  var OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if(!OfflineCtx) return Promise.resolve(null);
  var ctx = new OfflineCtx(1, Math.floor(sampleRate*durationSec), sampleRate);
  var osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(baseFreq, 0);
  osc.frequency.linearRampToValueAtTime(baseFreq*1.15, durationSec*0.5);
  osc.frequency.linearRampToValueAtTime(baseFreq*0.9, durationSec);
  var gain = ctx.createGain();
  gain.gain.setValueAtTime(0,0);
  gain.gain.linearRampToValueAtTime(0.16, 0.08);
  gain.gain.setValueAtTime(0.16, Math.max(0.09, durationSec-0.3));
  gain.gain.linearRampToValueAtTime(0, durationSec);
  osc.connect(gain).connect(ctx.destination);
  osc.start(0); osc.stop(durationSec);
  return ctx.startRendering().then(function(rendered){
    var data = rendered.getChannelData(0);
    var blob = encodeWAV(data, sampleRate);
    return { url: URL.createObjectURL(blob), duration: durationSec };
  }).catch(function(){ return null; });
}
function playChime(urgent){
  try{
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    var now0 = ctx.currentTime;
    var notes = urgent ? [880,1108,1318] : [740];
    notes.forEach(function(f,i){
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = f;
      var t = now0 + i*0.11;
      gain.gain.setValueAtTime(0,t);
      gain.gain.linearRampToValueAtTime(urgent?0.13:0.08, t+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t+0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t+0.4);
    });
    setTimeout(function(){ ctx.close(); }, 900);
  }catch(e){}
}

/* fridge thermostat illustration as inline SVG data URI (stand-in "photo") */
function fridgeImageSrc(){
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">'
    + '<rect width="480" height="360" fill="#eef1f4"/>'
    + '<rect x="150" y="30" width="180" height="300" rx="14" fill="#dfe3e8" stroke="#c3c8d0" stroke-width="2"/>'
    + '<rect x="164" y="46" width="152" height="118" rx="8" fill="#c9ced6"/>'
    + '<rect x="164" y="176" width="152" height="138" rx="8" fill="#c9ced6"/>'
    + '<rect x="196" y="210" width="88" height="64" rx="10" fill="#101216"/>'
    + '<text x="240" y="238" font-family="Menlo,monospace" font-size="26" fill="#ff5a4d" text-anchor="middle" font-weight="700">9.4&#176;C</text>'
    + '<text x="240" y="260" font-family="Menlo,monospace" font-size="11" fill="#ff8478" text-anchor="middle">WALK-IN 2 &#183; HIGH</text>'
    + '<circle cx="296" cy="196" r="5" fill="#ff5a4d"/>'
    + '</svg>';
  return "data:image/svg+xml;base64," + btoa(svg);
}

/* ---------------- Rendering ---------------- */
var switcherRow = document.getElementById("switcherRow");
var threadList = document.getElementById("threadList");
var threadScroll = document.getElementById("threadScroll");
var hAvatar = document.getElementById("hAvatar");
var hName = document.getElementById("hName");
var hSub = document.getElementById("hSub");
var filterCountAll = document.getElementById("filterCountAll");
var filterCountUnread = document.getElementById("filterCountUnread");
var filterCountUrgent = document.getElementById("filterCountUrgent");
var searchInput = document.getElementById("searchInput");
var searchClear = document.getElementById("searchClear");
var searchEmpty = document.getElementById("searchEmpty");
var searchEmptyTerm = document.getElementById("searchEmptyTerm");
var searchEmptyUnread = document.getElementById("searchEmptyUnread");
var searchEmptyMatch = document.getElementById("searchEmptyMatch");
var searchEmptyLoading = document.getElementById("searchEmptyLoading");

searchInput.addEventListener("input", function(){
  STATE.searchTerm = searchInput.value;
  searchClear.hidden = STATE.searchTerm.length === 0;
  renderList();
});
searchClear.addEventListener("click", function(){
  searchInput.value = "";
  STATE.searchTerm = "";
  searchClear.hidden = true;
  renderList();
  searchInput.focus();
});

var chatFilterRow = document.getElementById("chatFilterRow");
STATE.chatFilter = "all";
chatFilterRow.addEventListener("click", function(e){
  var btn = e.target.closest(".chat-filter-chip");
  if(!btn) return;
  STATE.chatFilter = btn.dataset.filter;
  chatFilterRow.querySelectorAll(".chat-filter-chip").forEach(function(c){ c.classList.toggle("active", c === btn); });
  renderList();
});

function renderSwitcher(){
  switcherRow.innerHTML = "";
  DEPT_ORDER.forEach(function(id){
    var d = DEPTS[id];
    var btn = document.createElement("button");
    btn.className = "sw-chip" + (id === STATE.self ? " active" : "");
    btn.title = d.name;
    btn.innerHTML = '<span class="sw-avatar" style="'+avatarStyleAttr(id)+'">'+avatarInnerHtml(id)+'</span>';
    btn.addEventListener("click", function(){ switchSelf(id); });
    switcherRow.appendChild(btn);
  });
}

function threadOrderKey(){ return "hp_thread_order_" + (AUTH.staff ? AUTH.staff.id : "anon"); }
function loadCustomThreadOrder(){
  try{ return JSON.parse(localStorage.getItem(threadOrderKey()) || "null"); }catch(e){ return null; }
}
function saveCustomThreadOrder(order){
  try{ localStorage.setItem(threadOrderKey(), JSON.stringify(order)); }catch(e){}
}
function sortedDeptIds(){
  var ids = Object.keys(STATE.data);
  var custom = loadCustomThreadOrder();
  if(custom && custom.length){
    var known = {};
    ids.forEach(function(id){ known[id] = true; });
    var ordered = custom.filter(function(id){ return known[id]; });
    ids.forEach(function(id){ if(ordered.indexOf(id) === -1) ordered.push(id); });
    return ordered;
  }
  return ids.sort(function(a,b){
    var la = lastOf(STATE.data[a]), lb = lastOf(STATE.data[b]);
    return (lb ? lb.t : 0) - (la ? la.t : 0);
  });
}

function unreadCount(deptId){
  return (STATE.data[deptId] || []).filter(function(m){ return !m.read && m.from !== "self"; }).length;
}
function hasUrgentUnread(deptId){
  return (STATE.data[deptId] || []).some(function(m){ return !m.read && m.urgent && m.from !== "self"; });
}

function fmtClockDuration(seconds){
  seconds = Math.max(0, Math.round(seconds || 0));
  var m = Math.floor(seconds / 60), s = seconds % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}
function previewText(m){
  if(m.poll) return (m.from === "self" ? "You: " : "") + "📊 Poll: " + m.poll.question;
  if(m.signoff) return (m.from === "self" ? "You: " : "") + "🖋 Sign-off request: " + m.signoff.title;
  if(m.type === "text") return (m.from === "self" ? "You: " : "") + m.text;
  if(m.type === "image") return (m.from === "self" ? "You: " : "") + "📷 Photo";
  if(m.type === "file") return (m.from === "self" ? "You: " : "") + "📎 " + m.fileName;
  if(m.type === "audio") return (m.from === "self" ? "You: " : "") + "🎤 Voice message" + (m.duration ? " (" + fmtClockDuration(m.duration) + ")" : "");
  return "";
}

function contactNameFor(id){
  var staff = STAFF_BY_DEPT[id];
  if(!staff || !staff.length) return null;
  if(staff.length === 1) return staff[0].name;
  return staff.map(function(s){ return s.name; }).join(", ");
}

function findSearchMatch(id, term){
  if(!term) return { match: true, message: null };
  var d = DEPTS[id];
  if(d.name.toLowerCase().indexOf(term) !== -1) return { match: true, message: null };
  var contact = contactNameFor(id);
  if(contact && contact.toLowerCase().indexOf(term) !== -1) return { match: true, message: null };
  var msgs = STATE.data[id] || [];
  for(var i = msgs.length - 1; i >= 0; i--){
    var t = (msgs[i].text || msgs[i].fileName || "").toLowerCase();
    if(t.indexOf(term) !== -1) return { match: true, message: msgs[i] };
  }
  return { match: false, message: null };
}

function renderList(){
  if(STATE.reordering) return;
  threadList.innerHTML = "";
  var term = (STATE.searchTerm || "").trim().toLowerCase();
  var matches = {};
  var ids = sortedDeptIds().filter(function(id){
    if(STATE.chatFilter === "unread" && unreadCount(id) === 0) return false;
    if(STATE.chatFilter === "urgent" && !hasUrgentUnread(id)) return false;
    var r = findSearchMatch(id, term);
    if(r.match) matches[id] = r.message;
    return r.match;
  });

  var allIds = sortedDeptIds();
  var unreadIds = allIds.filter(function(id){ return unreadCount(id) > 0; });
  var urgentIds = allIds.filter(function(id){ return hasUrgentUnread(id); });
  filterCountAll.textContent = allIds.length ? String(allIds.length) : "";
  filterCountUnread.textContent = unreadIds.length ? String(unreadIds.length) : "";
  filterCountUrgent.textContent = urgentIds.length ? String(urgentIds.length) : "";
  searchEmpty.hidden = ids.length > 0;
  threadList.hidden = ids.length === 0;
  if(ids.length === 0){
    var stillLoading = STATE.loading && !Object.keys(STATE.data).length && !term && STATE.chatFilter === "all";
    searchEmptyLoading.hidden = !stillLoading;
    if(stillLoading){
      searchEmptyUnread.hidden = true;
      searchEmptyMatch.hidden = true;
      return;
    }
    var filterEmpty = (STATE.chatFilter === "unread" || STATE.chatFilter === "urgent") && !term;
    searchEmptyUnread.hidden = !filterEmpty;
    searchEmptyMatch.hidden = filterEmpty;
    if(filterEmpty) searchEmptyUnread.textContent = STATE.chatFilter === "urgent" ? "No urgent conversations" : "No unread conversations";
    searchEmptyTerm.textContent = STATE.searchTerm;
    return;
  }
  ids.forEach(function(id){
    var d = DEPTS[id];
    var msgs = STATE.data[id] || [];
    var last = lastOf(msgs);
    var unread = unreadCount(id);
    var urgentUnread = hasUrgentUnread(id);
    var contact = contactNameFor(id);
    var searchHit = matches[id];

    var el = document.createElement("button");
    var showActive = STATE.threadOpened || window.innerWidth > 720;
    el.className = "thread-item" + (showActive && id === STATE.active ? " active" : "") + (unread ? " unread" : "") + (urgentUnread ? " urgent-row" : "");
    el.setAttribute("data-dept-id", id);
    el.innerHTML =
      '<div class="t-avatar'+(urgentUnread?' urgent-ring':'')+' duty-'+(isOnDuty(id)?'on':'off')+'" style="'+avatarStyleAttr(id)+'" title="'+(isOnDuty(id)?'On duty':'Off duty')+'">'+avatarInnerHtml(id)+'</div>'+
      '<div class="t-body">'+
        '<div class="t-row1"><span class="t-name">'+d.name+(contact ? ' <span class="t-contact">· '+esc(contact)+'</span>' : '')+(STATE.muted[id] ? ' <svg class="t-mute-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M8.7 3A6 6 0 0 1 18 8c0 2.9.6 5 1.3 6.3"/><path d="M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 9-3 9h14"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' : '')+'</span><span class="t-time">'+(last ? fmtRelative(last.t) : '')+'</span></div>'+
        '<div class="t-row2"><span class="t-preview'+(searchHit?' search-hit':'')+'">'+(searchHit ? esc(previewText(searchHit)) : (last ? esc(previewText(last)) : 'No messages yet'))+'</span>'+
          (unread ? '<span class="t-badge'+(urgentUnread?' urgent':'')+'">'+unread+'</span>' : '')+
        '</div>'+
      '</div>';
    el.addEventListener("click", function(){
      if(el._suppressClick){ el._suppressClick = false; return; }
      openThread(id);
      if(searchHit){
        setTimeout(function(){
          var target = threadScroll.querySelector('[data-msg-id="'+searchHit.id+'"]');
          if(target){
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.classList.add("flash-highlight");
            setTimeout(function(){ target.classList.remove("flash-highlight"); }, 1200);
          }
        }, 80);
      }
    });
    attachThreadReorder(el, id);
    threadList.appendChild(el);
  });
}

function attachThreadReorder(el, deptId){
  var LONG_PRESS_MS = 350, MOVE_TOLERANCE = 10;
  var timer = null, startX = 0, startY = 0, pointerId = null;
  var dragging = false, ghost = null, rowH = 0, grabOffsetY = 0;
  var order = [], elems = [], startRect = null, lastTargetIndex = null;

  function teardown(){
    document.removeEventListener("pointermove", onPreMove);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    clearTimeout(timer);
    pointerId = null;
  }
  function onDown(e){
    if(e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    clearTimeout(timer);
    timer = setTimeout(function(){ startLift(e); }, LONG_PRESS_MS);
    document.addEventListener("pointermove", onPreMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  }
  function onPreMove(e){
    if(e.pointerId !== pointerId || dragging) return;
    if(Math.abs(e.clientX-startX) > MOVE_TOLERANCE || Math.abs(e.clientY-startY) > MOVE_TOLERANCE){
      clearTimeout(timer);
    }
  }
  function startLift(e){
    dragging = true;
    STATE.reordering = true;
    document.removeEventListener("pointermove", onPreMove);
    document.addEventListener("pointermove", onMove);
    if(navigator.vibrate) navigator.vibrate(12);
    elems = Array.prototype.slice.call(threadList.querySelectorAll(".thread-item"));
    order = elems.map(function(x){ return x.getAttribute("data-dept-id"); });
    startRect = el.getBoundingClientRect();
    var next = el.nextElementSibling;
    rowH = startRect.height + (next ? next.getBoundingClientRect().top - startRect.bottom : 8);
    grabOffsetY = startY - startRect.top;
    ghost = el.cloneNode(true);
    ghost.classList.add("thread-drag-ghost");
    ghost.style.position = "fixed";
    ghost.style.left = startRect.left + "px";
    ghost.style.top = startRect.top + "px";
    ghost.style.width = startRect.width + "px";
    ghost.style.margin = "0";
    document.body.appendChild(ghost);
    el.classList.add("reorder-source-hidden");
  }
  function applyShifts(targetIndex){
    var fromIndex = order.indexOf(deptId);
    elems.forEach(function(node, i){
      if(node === el) return;
      var shift = 0;
      if(fromIndex < targetIndex){
        if(i > fromIndex && i <= targetIndex) shift = -rowH;
      } else if(fromIndex > targetIndex){
        if(i >= targetIndex && i < fromIndex) shift = rowH;
      }
      node.style.transform = shift ? "translateY(" + shift + "px)" : "";
      node.style.transition = "transform .15s ease";
    });
  }
  function onMove(e){
    if(e.pointerId !== pointerId || !dragging) return;
    e.preventDefault();
    var y = e.clientY - grabOffsetY;
    ghost.style.top = y + "px";
    var fromIndex = order.indexOf(deptId);
    var idx = fromIndex + Math.round((e.clientY - startY) / rowH);
    idx = Math.max(0, Math.min(order.length - 1, idx));
    if(idx !== lastTargetIndex){
      lastTargetIndex = idx;
      applyShifts(idx);
    }
  }
  function settle(){
    elems.forEach(function(node){ node.style.transform = ""; node.style.transition = ""; });
    el.classList.remove("reorder-source-hidden");
    if(ghost){ ghost.remove(); ghost = null; }
    STATE.reordering = false;
  }
  function onUp(e){
    if(e.pointerId !== pointerId) return;
    var wasDragging = dragging;
    teardown();
    if(!wasDragging){ return; }
    el._suppressClick = true;
    dragging = false;
    var fromIndex = order.indexOf(deptId);
    var toIndex = lastTargetIndex === null ? fromIndex : lastTargetIndex;
    settle();
    if(toIndex !== fromIndex){
      var newOrder = order.slice();
      newOrder.splice(fromIndex, 1);
      newOrder.splice(toIndex, 0, deptId);
      saveCustomThreadOrder(newOrder);
      if(navigator.vibrate) navigator.vibrate(10);
    }
    lastTargetIndex = null;
    renderList();
  }
  function onCancel(e){
    if(e.pointerId !== pointerId) return;
    teardown();
    if(dragging){ dragging = false; lastTargetIndex = null; settle(); }
  }
  el.addEventListener("pointerdown", onDown);
}

function markRead(deptId){
  var hadUnread = (STATE.data[deptId] || []).some(function(m){ return m.from !== "self" && !m.read; });
  (STATE.data[deptId] || []).forEach(function(m){ if(m.from !== "self") { m.read = true; m.status = "read"; } });
  if(hadUnread) apiSend('/api/messages/read', 'POST', { self: STATE.self, with: deptId }).catch(function(){});
}

function openThread(deptId){
  var __openT0 = performance.now();
  if(STATE.active !== deptId){ clearReplyBar(); clearEditBar(); mentionPopover.hidden = true; saveCurrentDraft(); }
  STATE.active = deptId;
  STATE.activeGroupId = null;
  STATE.threadOpened = true;
  loadDraftInto(deptId, null);
  markRead(deptId);
  renderList();
  renderHeader();
  renderThread();
  document.getElementById("sidebar").classList.add("hide-mobile");
  document.querySelector(".main").classList.add("show-mobile");
  focusInput();
  if(window.innerWidth <= 720 && !(history.state && history.state.dashThread)){
    history.pushState({ dashThread: true }, "");
  }
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      console.log("[PERF] openThread->visible", (performance.now() - __openT0).toFixed(1) + "ms", "dept=" + deptId, "msgCount=" + ((STATE.data[deptId]||[]).length));
    });
  });
}

function closeThreadView(){
  saveCurrentDraft();
  document.getElementById("sidebar").classList.remove("hide-mobile");
  document.querySelector(".main").classList.remove("show-mobile");
  STATE.activeGroupId = null;
}

window.addEventListener("popstate", function(){
  closeThreadView();
});

function hexToRgba(hex, a){
  var n = parseInt(hex.slice(1), 16);
  return "rgba("+((n>>16)&255)+","+((n>>8)&255)+","+(n&255)+","+a+")";
}
var hContactWrap = document.getElementById("hContactWrap");
var hGroupAvatars = document.getElementById("hGroupAvatars");
hGroupAvatars.addEventListener("click", function(){
  hGroupAvatars.classList.toggle("expanded");
});

var offDutyBanner = document.getElementById("offDutyBanner");
var eventNotice = document.getElementById("eventNotice");
var hDot = document.getElementById("hDot");
var muteBtn = document.getElementById("muteBtn");
var callBtn = document.getElementById("callBtn");
muteBtn.addEventListener("click", function(){
  var deptId = STATE.active;
  var wasMuted = !!STATE.muted[deptId];
  STATE.muted[deptId] = !wasMuted;
  muteBtn.classList.toggle("active", !wasMuted);
  renderList();
  apiSend('/api/muted', 'POST', { with: deptId }).then(function(res){
    STATE.muted[deptId] = res.muted;
    muteBtn.classList.toggle("active", res.muted);
    muteBtn.title = res.muted ? "Unmute this conversation" : "Mute notifications for this conversation";
    renderList();
    showToast(res.muted ? "Muted" : "Unmuted");
  }).catch(function(){
    STATE.muted[deptId] = wasMuted;
    muteBtn.classList.toggle("active", wasMuted);
    renderList();
  });
});

function renderHeader(){
  if(STATE.activeGroupId){
    var g = STATE.groups.find(function(x){ return x.id === STATE.activeGroupId; });
    hAvatar.style.background = "linear-gradient(155deg, #2c2c30, #131315)";
    hAvatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/><circle cx="12" cy="15" r="2.2"/></svg>';
    hName.textContent = g ? g.name : "Event";
    hSub.textContent = g ? (g.members.length + (g.members.length === 1 ? " person" : " people")) : "";
    hSub.classList.remove("typing");
    hDot.hidden = true;
    hContactWrap.innerHTML = "";
    hGroupAvatars.hidden = false;
    hGroupAvatars.classList.remove("expanded");
    hGroupAvatars.innerHTML = g ? g.members.map(function(deptId){
      return '<span class="group-avatar" style="'+avatarStyleAttr(deptId)+'" title="'+esc(DEPTS[deptId] ? DEPTS[deptId].name : deptId)+'">'+avatarInnerHtml(deptId)+'</span>';
    }).join("") : "";
    offDutyBanner.hidden = true;
    eventNotice.hidden = !!(g && g.archivedAt);
    muteBtn.hidden = true;
    filesBtn.hidden = true;
    callBtn.hidden = true;
    optTask.hidden = true;
    if(taskActive) setTaskActive(false);
    optSignoff.hidden = true;
    if(signoffActive) clearSignoffTag();
    return;
  }
  eventNotice.hidden = true;
  hDot.hidden = false;
  hGroupAvatars.hidden = true;
  muteBtn.hidden = false;
  filesBtn.hidden = false;
  optTask.hidden = false;
  optSignoff.hidden = false;
  var d = DEPTS[STATE.active];
  hAvatar.setAttribute("style", avatarStyleAttr(STATE.active));
  hAvatar.innerHTML = avatarInnerHtml(STATE.active);
  hName.textContent = contactNameFor(STATE.active) || d.name;
  var targetOn = isOnDuty(STATE.active);
  if(STATE.typingFrom[STATE.active]){
    hSub.textContent = "Typing…";
    hSub.classList.add("typing");
  } else {
    hSub.textContent = targetOn ? "Active now" : "Off duty";
    hSub.classList.remove("typing");
  }
  hDot.classList.toggle("off", !targetOn);
  renderContactName();
  renderOffDutyBanner();
  muteBtn.classList.toggle("active", !!STATE.muted[STATE.active]);
  muteBtn.title = STATE.muted[STATE.active] ? "Unmute this conversation" : "Mute notifications for this conversation";
  renderCallBtn();
}

function callablePeopleFor(deptId){
  return (STAFF_BY_DEPT[deptId] || []).filter(function(s){ return s.phone; });
}
function renderCallBtn(){
  callBtn.hidden = callablePeopleFor(STATE.active).length === 0;
}
callBtn.addEventListener("click", function(){
  var people = callablePeopleFor(STATE.active);
  if(!people.length) return;
  if(people.length === 1){
    window.location.href = "tel:" + people[0].phone;
    return;
  }
  openCallPicker(people);
});
var callPickerOverlay = document.getElementById("callPickerOverlay");
var callPickerClose = document.getElementById("callPickerClose");
var callPickerList = document.getElementById("callPickerList");
function openCallPicker(people){
  callPickerList.innerHTML = people.map(function(s){
    return '<button type="button" class="forward-dept-opt" data-phone="'+esc(s.phone)+'">'+
      '<span class="fwd-avatar" style="'+avatarStyleAttr(STATE.active)+'">'+avatarInnerHtml(STATE.active)+'</span>'+
      '<span>'+esc(s.name)+'<br><span style="font-weight:400;color:var(--text-faint);font-size:12.5px">'+esc(s.phone)+'</span></span>'+
    '</button>';
  }).join("");
  callPickerList.querySelectorAll(".forward-dept-opt").forEach(function(btn){
    btn.addEventListener("click", function(){
      window.location.href = "tel:" + btn.getAttribute("data-phone");
      callPickerOverlay.hidden = true;
    });
  });
  callPickerOverlay.hidden = false;
}
callPickerClose.addEventListener("click", function(){ callPickerOverlay.hidden = true; });
callPickerOverlay.addEventListener("click", function(e){ if(e.target === callPickerOverlay) callPickerOverlay.hidden = true; });

function renderOffDutyBanner(){
  var d = DEPTS[STATE.active];
  var name = contactNameFor(STATE.active) || d.name;
  if(isOnDuty(STATE.active)){
    offDutyBanner.hidden = true;
    return;
  }
  offDutyBanner.hidden = false;
  offDutyBanner.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5l3 2"/><circle cx="12" cy="12" r="9"/></svg>'+
    '<span><b>'+esc(name)+'</b> is off duty right now. They won’t be notified until they’re back on.</span>';
}

function renderContactName(){
  var deptId = STATE.active;
  var d = DEPTS[deptId];
  var contact = contactNameFor(deptId);
  hContactWrap.innerHTML = "";
  var roleLabel = (contact && contact !== d.name) ? d.name : null;
  if(roleLabel){
    var span = document.createElement("span");
    span.className = "h-contact-name";
    span.textContent = roleLabel;
    hContactWrap.appendChild(span);
    var sep = document.createElement("span");
    sep.textContent = " ·";
    sep.style.color = "var(--text-faint)";
    hContactWrap.appendChild(sep);
  }
}

function sameDay(a,b){
  var da = new Date(a), db = new Date(b);
  return da.toDateString() === db.toDateString();
}

function buildAudioNode(msg, holderIsOut){
  var wrap = document.createElement("div");
  wrap.className = "bubble audio-bubble";
  var bars = [];
  for(var i=0;i<20;i++){ bars.push(6 + Math.round(14*Math.abs(Math.sin(i*1.7+ (msg.freq||3)))));}
  var barsHTML = bars.map(function(h){ return '<span class="wave-bar" style="height:'+h+'px"></span>'; }).join("");

  wrap.innerHTML =
    '<button class="play-btn" aria-label="Play voice message">'+
      '<svg class="ic-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'+
      '<svg class="ic-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'+
    '</button>'+
    '<div class="wave"><div class="wave-static" style="display:flex;align-items:center;gap:2px;width:100%">'+barsHTML+'</div>'+
      '<div class="wave-progress"><div style="display:flex;align-items:center;gap:2px">'+barsHTML+'</div></div>'+
    '</div>'+
    '<span class="audio-dur">'+fmtDur(msg.duration||msg.dur||4)+'</span>';

  var audioEl = new Audio();
  audioEl.preload = "none";
  var playBtn = wrap.querySelector(".play-btn");
  var icPlay = wrap.querySelector(".ic-play");
  var icPause = wrap.querySelector(".ic-pause");
  var progress = wrap.querySelector(".wave-progress");
  var durLabel = wrap.querySelector(".audio-dur");
  var totalDur = msg.duration || msg.dur || 4;
  var ready = false;

  function ensureSrc(){
    if(msg.url){ audioEl.src = msg.url; ready = true; return Promise.resolve(); }
    return makeToneVoiceNote(msg.dur, msg.freq).then(function(res){
      if(res){ msg.url = res.url; audioEl.src = res.url; ready = true; }
    });
  }

  playBtn.addEventListener("click", function(){
    if(audioEl.paused){
      var startPlayback = function(){
        audioEl.play().catch(function(){});
      };
      if(!ready){ ensureSrc().then(startPlayback); } else { startPlayback(); }
      icPlay.style.display = "none"; icPause.style.display = "";
    } else {
      audioEl.pause();
      icPlay.style.display = ""; icPause.style.display = "none";
    }
  });
  audioEl.addEventListener("timeupdate", function(){
    var pct = audioEl.duration ? (audioEl.currentTime/audioEl.duration*100) : 0;
    progress.style.width = pct + "%";
    durLabel.textContent = fmtDur(Math.max(0, totalDur - audioEl.currentTime));
  });
  audioEl.addEventListener("ended", function(){
    icPlay.style.display = ""; icPause.style.display = "none";
    progress.style.width = "0%";
    durLabel.textContent = fmtDur(totalDur);
  });
  return wrap;
}
function fmtDur(s){
  s = Math.max(0, Math.round(s));
  var m = Math.floor(s/60), r = s%60;
  return m + ":" + (r<10?"0":"")+r;
}

function renderThread(){
  threadScroll.innerHTML = "";
  var msgs = STATE.activeGroupId ? (STATE.groupMessages[STATE.activeGroupId] || []) : STATE.data[STATE.active];
  if(!msgs.length){
    threadScroll.innerHTML =
      '<div class="thread-empty-state">'+
        '<div class="thread-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div>'+
        '<div class="thread-empty-title">No messages yet</div>'+
        '<div class="thread-empty-sub">Say hello to start the conversation.</div>'+
      '</div>';
    return;
  }
  var prevDay = null;
  var msgsById = {};
  msgs.forEach(function(m){ msgsById[m.id] = m; });

  msgs.forEach(function(m, i){
    if(!prevDay || !sameDay(prevDay, m.t)){
      var div = document.createElement("div");
      div.className = "day-div";
      div.textContent = new Date(m.t).toLocaleDateString([], {weekday:"long", month:"short", day:"numeric"});
      threadScroll.appendChild(div);
      prevDay = m.t;
    }
    var next = msgs[i+1];
    var prev = msgs[i-1];
    var groupEnd = !next || next.from !== m.from || !sameDay(next.t, m.t);
    var groupStart = !prev || prev.from !== m.from || !sameDay(prev.t, m.t);
    threadScroll.appendChild(buildMessageRow(m, groupEnd, msgsById, groupStart));
  });
  threadScroll.scrollTop = threadScroll.scrollHeight;
}

var broadcastStatusCache = {};
function loadBroadcastStatus(broadcastId){
  var cached = broadcastStatusCache[broadcastId];
  if(cached && Date.now() - cached.at < 15000) return Promise.resolve(cached.data);
  return apiGet('/api/broadcast/' + encodeURIComponent(broadcastId) + '/status').then(function(res){
    broadcastStatusCache[broadcastId] = { at: Date.now(), data: res };
    return res;
  });
}

function messagePreviewLabel(m){
  if(!m) return "";
  if(m.deleted && !m.text && !m.url && !m.transcript) return "Deleted message";
  if(m.type === "image") return "📷 Photo" + (m.text ? ": " + m.text : "");
  if(m.type === "file") return "📎 " + (m.fileName || "File");
  if(m.type === "audio") return "🎤 Voice message";
  return m.text || "";
}

function replySenderName(m){
  if(!m) return "";
  if(m.from === "self") return "You";
  return DEPTS[m.from] ? DEPTS[m.from].name : m.from;
}

var replyPreviewBar = document.getElementById("replyPreviewBar");
var replyPreviewName = document.getElementById("replyPreviewName");
var replyPreviewText = document.getElementById("replyPreviewText");
var replyPreviewClose = document.getElementById("replyPreviewClose");

function showReplyBar(m){
  STATE.replyingTo = { id: m.id, from: m.from, preview: messagePreviewLabel(m) };
  replyPreviewName.textContent = replySenderName(m);
  replyPreviewText.textContent = STATE.replyingTo.preview;
  replyPreviewBar.hidden = false;
  msgInput.focus();
}
function clearReplyBar(){
  STATE.replyingTo = null;
  replyPreviewBar.hidden = true;
}
replyPreviewClose.addEventListener("click", clearReplyBar);

var editBar = document.getElementById("editBar");
var editBarClose = document.getElementById("editBarClose");
function showEditBar(m){
  clearReplyBar();
  clearRoomTagBar();
  setTaskActive(false);
  STATE.editingMessage = m;
  msgInput.value = m.text || "";
  autoGrow();
  refreshSendState();
  editBar.hidden = false;
  msgInput.focus();
}
function clearEditBar(){
  STATE.editingMessage = null;
  editBar.hidden = true;
}
editBarClose.addEventListener("click", function(){
  clearEditBar();
  msgInput.value = "";
  autoGrow();
  refreshSendState();
});

function draftKeyFor(deptId, groupId){
  var staffId = AUTH.staff ? AUTH.staff.id : "anon";
  if(groupId) return "hp_draft_" + staffId + "_group_" + groupId;
  if(deptId) return "hp_draft_" + staffId + "_dept_" + deptId;
  return null;
}
function saveCurrentDraft(){
  if(STATE.editingMessage) return;
  var key = draftKeyFor(STATE.active, STATE.activeGroupId);
  if(!key) return;
  var val = msgInput.value;
  try{
    if(val) localStorage.setItem(key, val);
    else localStorage.removeItem(key);
  }catch(e){}
}
function loadDraftInto(deptId, groupId){
  var key = draftKeyFor(deptId, groupId);
  var val = "";
  if(key){
    try{ val = localStorage.getItem(key) || ""; }catch(e){ val = ""; }
  }
  msgInput.value = val;
  autoGrow();
  refreshSendState();
}

var roomTagBar = document.getElementById("roomTagBar");
var roomTagInput = document.getElementById("roomTagInput");
var roomTagClose = document.getElementById("roomTagClose");
function showRoomTagBar(){
  roomTagBar.hidden = false;
  roomTagInput.focus();
}
function clearRoomTagBar(){
  roomTagInput.value = "";
  roomTagBar.hidden = true;
}
roomTagClose.addEventListener("click", clearRoomTagBar);
roomTagInput.addEventListener("keydown", function(e){
  if(e.key === "Enter"){ e.preventDefault(); msgInput.focus(); }
});

var taskTagBar = document.getElementById("taskTagBar");
var taskTagClose = document.getElementById("taskTagClose");
function setTaskActive(on){
  taskActive = on;
  optTask.classList.toggle("active", on);
  taskTagBar.hidden = !on;
}
taskTagClose.addEventListener("click", function(){ setTaskActive(false); });

var signoffTagBar = document.getElementById("signoffTagBar");
var signoffTagText = document.getElementById("signoffTagText");
var signoffTagClose = document.getElementById("signoffTagClose");
var signoffOverlay = document.getElementById("signoffOverlay");
var signoffClose = document.getElementById("signoffClose");
var signoffForm = document.getElementById("signoffForm");
var signoffTitleInput = document.getElementById("signoffTitleInput");
var signoffAmountInput = document.getElementById("signoffAmountInput");
var signoffTargetInput = document.getElementById("signoffTargetInput");
var signoffCategoryInput = document.getElementById("signoffCategoryInput");
var signoffGuestInput = document.getElementById("signoffGuestInput");
var signoffFormError = document.getElementById("signoffFormError");
var signoffActive = false;
var signoffData = null;
function clearSignoffTag(){
  signoffActive = false;
  signoffData = null;
  optSignoff.classList.remove("active");
  signoffTagBar.hidden = true;
}
signoffTagClose.addEventListener("click", clearSignoffTag);
function openSignoffOverlay(){
  signoffFormError.textContent = "";
  signoffTitleInput.value = signoffData ? signoffData.title : "";
  signoffAmountInput.value = signoffData && signoffData.amount != null ? signoffData.amount : "";
  signoffTargetInput.value = signoffData && signoffData.target ? signoffData.target : "";
  signoffCategoryInput.value = signoffData && signoffData.category ? signoffData.category : "";
  signoffGuestInput.value = signoffData && signoffData.guestInfo ? signoffData.guestInfo : "";
  signoffOverlay.hidden = false;
  setTimeout(function(){ signoffTitleInput.focus(); }, 30);
}
signoffClose.addEventListener("click", function(){ signoffOverlay.hidden = true; });
signoffOverlay.addEventListener("click", function(e){ if(e.target === signoffOverlay) signoffOverlay.hidden = true; });
signoffForm.addEventListener("submit", function(e){
  e.preventDefault();
  var title = signoffTitleInput.value.trim();
  if(!title){ signoffFormError.textContent = "Title is required."; return; }
  var amountRaw = signoffAmountInput.value.trim();
  var amount = amountRaw ? Number(amountRaw) : null;
  if(amountRaw && (!isFinite(amount) || amount < 0)){ signoffFormError.textContent = "Enter a valid amount."; return; }
  signoffData = {
    title: title, amount: amount, target: signoffTargetInput.value.trim() || null,
    category: signoffCategoryInput.value || null, guestInfo: signoffGuestInput.value.trim() || null
  };
  signoffActive = true;
  optSignoff.classList.add("active");
  signoffTagText.textContent = title + (amount != null ? " · £" + amount.toFixed(2) : "");
  signoffTagBar.hidden = false;
  signoffOverlay.hidden = true;
  msgInput.focus();
});

var appToast = document.getElementById("appToast");
var toastTimer = null;
function showToast(text){
  appToast.textContent = text;
  appToast.hidden = false;
  void appToast.offsetWidth;
  appToast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){
    appToast.classList.remove("show");
    setTimeout(function(){ appToast.hidden = true; }, 200);
  }, 1600);
}

var confirmOverlay = document.getElementById("confirmOverlay");
var confirmModalIcon = document.getElementById("confirmModalIcon");
var confirmModalTitle = document.getElementById("confirmModalTitle");
var confirmModalBody = document.getElementById("confirmModalBody");
var confirmModalCancel = document.getElementById("confirmModalCancel");
var confirmModalConfirm = document.getElementById("confirmModalConfirm");
var CONFIRM_ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
var CONFIRM_ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>';
var confirmResolve = null;
function showConfirm(opts){
  opts = opts || {};
  confirmModalIcon.innerHTML = opts.icon || CONFIRM_ICON_TRASH;
  confirmModalIcon.className = "confirm-modal-icon" + (opts.neutral ? " neutral" : "");
  confirmModalTitle.textContent = opts.title || "Are you sure?";
  confirmModalBody.textContent = opts.body || "";
  confirmModalConfirm.textContent = opts.confirmLabel || "Delete";
  confirmModalConfirm.className = "confirm-modal-btn confirm" + (opts.neutral ? " neutral" : "");
  confirmModalCancel.textContent = opts.cancelLabel || "Cancel";
  confirmOverlay.hidden = false;
  requestAnimationFrame(function(){ confirmOverlay.classList.add("open"); });
  return new Promise(function(resolve){ confirmResolve = resolve; });
}
function hideConfirm(result){
  confirmOverlay.classList.remove("open");
  setTimeout(function(){ confirmOverlay.hidden = true; }, 160);
  if(confirmResolve){ var r = confirmResolve; confirmResolve = null; r(result); }
}
confirmModalCancel.addEventListener("click", function(){ hideConfirm(false); });
confirmModalConfirm.addEventListener("click", function(){ hideConfirm(true); });
confirmOverlay.addEventListener("click", function(e){ if(e.target === confirmOverlay) hideConfirm(false); });

var promptOverlay = document.getElementById("promptOverlay");
var promptModalTitle = document.getElementById("promptModalTitle");
var promptModalBody = document.getElementById("promptModalBody");
var promptModalInput = document.getElementById("promptModalInput");
var promptModalCancel = document.getElementById("promptModalCancel");
var promptModalConfirm = document.getElementById("promptModalConfirm");
var promptResolve = null;
function showPrompt(opts){
  opts = opts || {};
  promptModalTitle.textContent = opts.title || "";
  promptModalBody.textContent = opts.body || "";
  promptModalBody.hidden = !opts.body;
  promptModalInput.placeholder = opts.placeholder || "";
  promptModalInput.value = opts.value || "";
  promptModalInput.maxLength = opts.maxLength || 200;
  promptModalConfirm.textContent = opts.confirmLabel || "Save";
  promptOverlay.hidden = false;
  requestAnimationFrame(function(){
    promptOverlay.classList.add("open");
    promptModalInput.focus();
    promptModalInput.select();
  });
  return new Promise(function(resolve){ promptResolve = resolve; });
}
function hidePrompt(result){
  promptOverlay.classList.remove("open");
  setTimeout(function(){ promptOverlay.hidden = true; }, 160);
  if(promptResolve){ var r = promptResolve; promptResolve = null; r(result); }
}
promptModalCancel.addEventListener("click", function(){ hidePrompt(null); });
promptModalConfirm.addEventListener("click", function(){ hidePrompt(promptModalInput.value); });
promptModalInput.addEventListener("keydown", function(e){
  if(e.key === "Enter"){ e.preventDefault(); hidePrompt(promptModalInput.value); }
  if(e.key === "Escape"){ e.preventDefault(); hidePrompt(null); }
});
promptOverlay.addEventListener("click", function(e){ if(e.target === promptOverlay) hidePrompt(null); });

var msgActionMenu = document.getElementById("msgActionMenu");
var msgActionBackdrop = document.getElementById("msgActionBackdrop");
var ACTION_ICONS = {
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h10a5 5 0 0 1 5 5v1"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17l5-5-5-5"/><path d="M20 12H10a5 5 0 0 0-5 5v1"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M8 3h8l-1 7 3 3H6l3-3-1-7z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>'
};

function hideMessageActionMenu(){
  msgActionMenu.classList.remove("open");
  msgActionBackdrop.hidden = true;
  setTimeout(function(){ msgActionMenu.hidden = true; }, 140);
}

function showMessageActionMenu(m, x, y){
  var canDelete = !m.deleted && (m.from === "self" || (AUTH.staff && AUTH.staff.isAdmin));
  var rows = [];
  rows.push({ key:"reply", label:"Reply", icon:ACTION_ICONS.reply });
  if(!m.deleted && m.from === "self" && m.type === "text") rows.push({ key:"edit", label:"Edit", icon:ACTION_ICONS.edit });
  rows.push({ key:"forward", label:"Forward", icon:ACTION_ICONS.forward });
  rows.push({ key:"copy", label:"Copy", icon:ACTION_ICONS.copy });
  rows.push({ key:"pin", label: m.pinned ? "Unpin" : "Pin", icon:ACTION_ICONS.pin });
  if(!m.deleted) rows.push({ key:"complete", label: m.completed ? "Mark as not done" : "Mark as done", icon:ACTION_ICONS.check });

  var html = rows.map(function(r){
    return '<button type="button" class="msg-action-row" data-action="'+r.key+'">'+r.icon+'<span>'+r.label+'</span></button>';
  }).join("");
  if(canDelete){
    html += '<div class="msg-action-divider"></div>' +
      '<button type="button" class="msg-action-row danger" data-action="delete">'+ACTION_ICONS.trash+'<span>Delete</span></button>';
  }
  msgActionMenu.innerHTML = html;

  msgActionMenu.hidden = false;
  msgActionBackdrop.hidden = false;
  var menuW = 200, menuH = msgActionMenu.getBoundingClientRect().height || 220;
  var left = Math.min(Math.max(8, x - menuW/2), window.innerWidth - menuW - 8);
  var top = y + 12;
  if(top + menuH > window.innerHeight - 8) top = Math.max(8, y - menuH - 12);
  msgActionMenu.style.left = left + "px";
  msgActionMenu.style.top = top + "px";
  requestAnimationFrame(function(){ msgActionMenu.classList.add("open"); });

  msgActionMenu.querySelectorAll(".msg-action-row").forEach(function(btn){
    btn.addEventListener("click", function(){
      var action = btn.getAttribute("data-action");
      hideMessageActionMenu();
      if(action === "reply") showReplyBar(m);
      else if(action === "edit") showEditBar(m);
      else if(action === "forward") openForwardPicker(m);
      else if(action === "copy") copyMessageContent(m);
      else if(action === "pin") togglePinMessage(m);
      else if(action === "complete") toggleCompleteMessage(m);
      else if(action === "delete") confirmDeleteMessage(m.id);
    });
  });
}
msgActionBackdrop.addEventListener("click", hideMessageActionMenu);

function copyMessageContent(m){
  var text = m.type === "text" ? m.text : messagePreviewLabel(m);
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ showToast("Copied"); }).catch(function(){ showToast("Couldn't copy"); });
  }
}

function currentMessagesArray(){
  if(STATE.activeGroupId){
    STATE.groupMessages[STATE.activeGroupId] = STATE.groupMessages[STATE.activeGroupId] || [];
    return STATE.groupMessages[STATE.activeGroupId];
  }
  STATE.data[STATE.active] = STATE.data[STATE.active] || [];
  return STATE.data[STATE.active];
}

function togglePinMessage(m){
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/pin', 'POST', {}).then(function(res){
    var msgs = currentMessagesArray();
    var idx = msgs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
    renderThread();
    showToast(res.message.pinned ? "Pinned" : "Unpinned");
  }).catch(function(){ showToast("Couldn't update pin"); });
}

function toggleCompleteMessage(m){
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/complete', 'POST', {}).then(function(res){
    var msgs = currentMessagesArray();
    var idx = msgs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
    renderThread();
    showToast(res.message.completed ? "Marked as done" : "Marked as not done");
  }).catch(function(){ showToast("Couldn't update that"); });
}

function decideSignoff(m, decision){
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/signoff-decision', 'POST', { decision: decision }).then(function(res){
    var msgs = currentMessagesArray();
    var idx = msgs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
    renderThread();
    showToast(decision === "approved" ? "Approved" : "Declined");
  }).catch(function(){ showToast("Couldn't record that decision"); });
}

var TASK_LABELS = { not_started: "New", in_progress: "Started", completed: "Completed" };
var TASK_NEXT = { not_started: "in_progress", in_progress: "completed", completed: "not_started" };
function cycleTaskStatus(m){
  var nextStatus = TASK_NEXT[m.taskStatus] || "not_started";
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/task-status', 'POST', { status: nextStatus }).then(function(res){
    var msgs = currentMessagesArray();
    var idx = msgs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
    renderThread();
    showToast(TASK_LABELS[nextStatus]);
  }).catch(function(){ showToast("Couldn't update that"); });
}

var forwardOverlay = document.getElementById("forwardOverlay");
var forwardClose = document.getElementById("forwardClose");
var forwardDeptList = document.getElementById("forwardDeptList");
var forwardError = document.getElementById("forwardError");
function openForwardPicker(m){
  forwardError.textContent = "";
  var targets = DEPT_ORDER.filter(function(id){ return id !== STATE.self && id !== STATE.active; });
  forwardDeptList.innerHTML = targets.map(function(id){
    return '<button type="button" class="forward-dept-opt" data-dept="'+id+'">'+
      '<span class="fwd-avatar" style="'+avatarStyleAttr(id)+'">'+avatarInnerHtml(id)+'</span>'+
      DEPTS[id].name+'</button>';
  }).join("");
  forwardDeptList.querySelectorAll(".forward-dept-opt").forEach(function(btn){
    btn.addEventListener("click", function(){
      var to = btn.getAttribute("data-dept");
      apiSend('/api/messages/' + encodeURIComponent(m.id) + '/forward', 'POST', { to: to }).then(function(res){
        STATE.data[to] = STATE.data[to] || [];
        STATE.data[to].push(mapServerMessage(res.message, STATE.self));
        renderList();
        if(STATE.active === to) renderThread();
        forwardOverlay.hidden = true;
        showToast("Forwarded to " + DEPTS[to].name);
      }).catch(function(e){ forwardError.textContent = e.message || "Couldn't forward that message."; });
    });
  });
  forwardOverlay.hidden = false;
}
forwardClose.addEventListener("click", function(){ forwardOverlay.hidden = true; });
forwardOverlay.addEventListener("click", function(e){ if(e.target === forwardOverlay) forwardOverlay.hidden = true; });

function attachLongPress(el, onLongPress){
  var LONG_PRESS_MS = 300, MOVE_TOLERANCE = 30;
  var timer = null, startX = 0, startY = 0, fired = false, suppressClick = false;
  function start(x, y){
    fired = false;
    startX = x; startY = y;
    clearTimeout(timer);
    timer = setTimeout(function(){
      fired = true;
      suppressClick = true;
      el.classList.remove("long-press-active");
      if(navigator.vibrate) navigator.vibrate(12);
      onLongPress(startX, startY);
    }, LONG_PRESS_MS);
    el.classList.add("long-press-active");
  }
  function cancel(){
    clearTimeout(timer);
    el.classList.remove("long-press-active");
  }
  el.addEventListener("touchstart", function(e){
    var t = e.touches[0];
    start(t.clientX, t.clientY);
  }, { passive: true });
  el.addEventListener("touchmove", function(e){
    var t = e.touches[0];
    if(Math.abs(t.clientX - startX) > MOVE_TOLERANCE || Math.abs(t.clientY - startY) > MOVE_TOLERANCE) cancel();
  }, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
  el.addEventListener("mousedown", function(e){ start(e.clientX, e.clientY); });
  el.addEventListener("mousemove", function(e){
    if(Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) cancel();
  });
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  el.addEventListener("click", function(e){
    if(suppressClick){
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

var pullRefresh = document.getElementById("pullRefresh");
function setupPullToRefresh(scrollEl, spinnerEl, onRefresh){
  var PULL_THRESHOLD = 60, PULL_MAX = 100;
  var startY = null, pulling = false, refreshing = false;
  scrollEl.addEventListener("touchstart", function(e){
    if(scrollEl.scrollTop <= 0 && !refreshing){
      startY = e.touches[0].clientY;
      pulling = true;
    } else {
      startY = null; pulling = false;
    }
  }, { passive: true });
  scrollEl.addEventListener("touchmove", function(e){
    if(!pulling || startY === null) return;
    var dy = e.touches[0].clientY - startY;
    if(dy <= 0){ return; }
    if(scrollEl.scrollTop > 0){ pulling = false; return; }
    e.preventDefault();
    var dist = Math.min(dy * 0.5, PULL_MAX);
    spinnerEl.style.top = (scrollEl.offsetTop - 34 + dist) + "px";
    spinnerEl.style.opacity = Math.min(dist / PULL_THRESHOLD, 1);
    spinnerEl.style.transform = "rotate(" + (dist * 3) + "deg)";
  }, { passive: false });
  scrollEl.addEventListener("touchend", function(e){
    if(!pulling || startY === null) return;
    var finalTop = parseFloat(spinnerEl.style.top || "0");
    var dist = finalTop - (scrollEl.offsetTop - 34);
    pulling = false; startY = null;
    if(dist >= PULL_THRESHOLD){
      refreshing = true;
      spinnerEl.style.top = (scrollEl.offsetTop + 14) + "px";
      spinnerEl.style.opacity = "1";
      onRefresh().catch(function(){});
      setTimeout(function(){
        refreshing = false;
        spinnerEl.style.opacity = "0";
        spinnerEl.style.transform = "";
      }, 350);
    } else {
      spinnerEl.style.opacity = "0";
      spinnerEl.style.transform = "";
    }
  });
}
setupPullToRefresh(threadScroll, pullRefresh, refreshNow);
setupPullToRefresh(threadList, document.getElementById("listPullRefresh"), refreshNow);

var TICK_SVG = '<svg viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6.5L5 10.5L11 2.5"/><path d="M7 6.5L11 10.5L17 2.5"/></svg>';

function fmtSignoffAmount(n){
  return "£" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function buildSignoffCard(m){
  var s = m.signoff;
  var card = document.createElement("div");
  card.className = "signoff-card " + s.status;
  var head = document.createElement("div");
  head.className = "signoff-head";
  head.innerHTML = '<span class="signoff-head-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg> HOD SIGN-OFF REQUEST' +
    (s.code ? ' <span class="signoff-code">'+esc(s.code)+'</span>' : '') + '</span>' +
    (s.amount != null ? '<span class="signoff-amount">'+fmtSignoffAmount(s.amount)+'</span>' : '');
  card.appendChild(head);

  if(s.category){
    var category = document.createElement("div");
    category.className = "signoff-category";
    category.textContent = s.category;
    card.appendChild(category);
  }

  var title = document.createElement("div");
  title.className = "signoff-title";
  title.textContent = s.title;
  card.appendChild(title);

  if(s.target){
    var target = document.createElement("div");
    target.className = "signoff-target";
    target.innerHTML = 'Target: <b>'+esc(s.target)+'</b>';
    card.appendChild(target);
  }

  if(s.guestInfo){
    var guestInfo = document.createElement("div");
    guestInfo.className = "signoff-target";
    guestInfo.innerHTML = 'Guest: <b>'+esc(s.guestInfo)+'</b>';
    card.appendChild(guestInfo);
  }

  var actions = document.createElement("div");
  actions.className = "signoff-actions";
  var canDecide = m.to === AUTH.staff.departmentId;
  if(s.status === "pending"){
    if(canDecide){
      var declineBtn = document.createElement("button");
      declineBtn.type = "button";
      declineBtn.className = "signoff-decline-btn";
      declineBtn.textContent = "Decline";
      declineBtn.addEventListener("click", function(){ decideSignoff(m, "declined"); });
      var approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "signoff-approve-btn";
      approveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Approve Sign-Off';
      approveBtn.addEventListener("click", function(){ decideSignoff(m, "approved"); });
      actions.appendChild(declineBtn);
      actions.appendChild(approveBtn);
    } else {
      var waitingLabel = document.createElement("div");
      waitingLabel.className = "signoff-status-badge pending";
      var toName = DEPTS[m.to] ? DEPTS[m.to].name : m.to;
      waitingLabel.textContent = "Awaiting sign-off from " + toName;
      actions.appendChild(waitingLabel);
    }
  } else {
    var badge = document.createElement("div");
    badge.className = "signoff-status-badge " + s.status;
    var byName = s.decidedBy || "";
    var decidedWhen = s.decidedAt ? fmtClock(s.decidedAt) : "";
    badge.innerHTML = (s.status === "approved"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> EXECUTED'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg> DECLINED') +
      (byName ? ' <span class="signoff-decided-by">by ' + esc(byName) + (decidedWhen ? ' · ' + decidedWhen : '') + '</span>' : '');
    actions.appendChild(badge);
  }
  card.appendChild(actions);
  return card;
}

function voteOnPoll(m, index){
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/vote', 'POST', { optionIndex: index }).then(function(res){
    var msgs = currentMessagesArray();
    var idx = msgs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
    renderThread();
  }).catch(function(){ showToast("Couldn't record your vote"); });
}
function buildPollCard(m){
  var p = m.poll;
  var votes = p.votes || {};
  var counts = p.options.map(function(_, i){
    return Object.keys(votes).filter(function(dept){ return votes[dept] === i; }).length;
  });
  var total = counts.reduce(function(a, b){ return a + b; }, 0);
  var myVote = votes[STATE.self];

  var card = document.createElement("div");
  card.className = "poll-card";
  var head = document.createElement("div");
  head.className = "poll-head";
  head.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><rect x="6" y="12" width="3" height="6" rx="0.5"/><rect x="11" y="8" width="3" height="10" rx="0.5"/><rect x="16" y="4" width="3" height="14" rx="0.5"/></svg> POLL';
  card.appendChild(head);

  var question = document.createElement("div");
  question.className = "poll-question";
  question.textContent = p.question;
  card.appendChild(question);

  var optionsWrap = document.createElement("div");
  optionsWrap.className = "poll-options";
  p.options.forEach(function(opt, i){
    var pct = total ? Math.round((counts[i] / total) * 100) : 0;
    var voters = Object.keys(votes).filter(function(dept){ return votes[dept] === i; });
    var optBtn = document.createElement("button");
    optBtn.type = "button";
    optBtn.className = "poll-option" + (myVote === i ? " voted" : "");
    optBtn.innerHTML =
      '<div class="poll-option-fill" style="width:' + pct + '%"></div>' +
      '<div class="poll-option-top">' +
        '<span class="poll-option-label">' + (myVote === i ? '<svg class="poll-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : '') + esc(opt) + '</span>' +
        '<span class="poll-option-pct">' + pct + '%</span>' +
      '</div>' +
      (voters.length ? '<div class="poll-voter-avatars">' + voters.map(function(dept){
        return '<span class="poll-voter-avatar" style="'+avatarStyleAttr(dept)+'" title="'+esc(DEPTS[dept] ? DEPTS[dept].name : dept)+'">'+avatarInnerHtml(dept)+'</span>';
      }).join("") + '</div>' : '');
    optBtn.addEventListener("click", function(){ voteOnPoll(m, i); });
    optionsWrap.appendChild(optBtn);
  });
  card.appendChild(optionsWrap);

  var meta = document.createElement("div");
  meta.className = "poll-meta";
  meta.textContent = total + (total === 1 ? " vote" : " votes");
  card.appendChild(meta);

  return card;
}

function buildMessageRow(m, groupEnd, msgsById, groupStart){
  var row = document.createElement("div");
  var out = m.from === "self";
  row.className = "msg-row " + (out?"out":"in") + (m.urgent ? " urgent" : "") + (groupEnd ? " group-end" : "") + (m.pending ? " pending" : "");
  row.setAttribute("data-msg-id", m.id);

  var wrap = document.createElement("div");
  wrap.className = "bubble-wrap";

  if(STATE.activeGroupId && !out && groupStart){
    var senderLabel = document.createElement("div");
    senderLabel.className = "group-sender-name";
    var senderDept = DEPTS[m.from];
    if(senderDept) senderLabel.style.color = senderDept.color;
    senderLabel.textContent = senderDept ? senderDept.name : m.from;
    wrap.appendChild(senderLabel);
  }

  var revealedDeleted = m.deleted && (m.text || m.url || m.transcript || m.dataUrl);

  if(m.deleted && !revealedDeleted){
    var delBubble = document.createElement("div");
    delBubble.className = "bubble deleted-bubble";
    delBubble.textContent = "This message was deleted";
    wrap.appendChild(delBubble);
    var delMeta = document.createElement("div");
    delMeta.className = out ? "msg-status" : "msg-time";
    delMeta.textContent = fmtClock(m.t);
    wrap.appendChild(delMeta);
    row.appendChild(wrap);
    return row;
  }

  if(revealedDeleted){
    var auditTag = document.createElement("div");
    auditTag.className = "audit-deleted-tag";
    auditTag.textContent = "Deleted" + (m.deletedAt ? " " + fmtClock(m.deletedAt) : "") + " · visible to management only";
    wrap.appendChild(auditTag);
  }

  if(m.urgent){
    var tag = document.createElement("div");
    tag.className = "urgent-tag";
    tag.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.7 17.3A1.8 1.8 0 0 0 4.3 20h15.4a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0z"/></svg> Urgent';
    wrap.appendChild(tag);
  }

  if(m.affectsGuest){
    var guestTag = document.createElement("div");
    guestTag.className = "guest-tag";
    guestTag.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18c0-3 2-5 3-8 .6-1.8 2-3 5-3s4.4 1.2 5 3c1 3 3 5 3 8"/><path d="M2 18h20"/></svg> Affects a guest';
    wrap.appendChild(guestTag);
  }

  if(m.taskStatus){
    var canActionTask = m.to === AUTH.staff.departmentId;
    var taskTag = document.createElement(canActionTask ? "button" : "div");
    if(canActionTask) taskTag.type = "button";
    taskTag.className = "task-msg-tag " + m.taskStatus + (canActionTask ? "" : " readonly");
    taskTag.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.3 2.3L16 9.5"/></svg> ' + TASK_LABELS[m.taskStatus];
    if(canActionTask) taskTag.addEventListener("click", function(){ cycleTaskStatus(m); });
    wrap.appendChild(taskTag);
  }

  if(m.pinned){
    var pinTag = document.createElement("div");
    pinTag.className = "pin-indicator";
    pinTag.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M8 3h8l-1 7 3 3H6l3-3-1-7z"/></svg> Pinned';
    wrap.appendChild(pinTag);
  }

  if(m.broadcastId && out){
    var bcTag = document.createElement("div");
    bcTag.className = "broadcast-status-tag";
    bcTag.textContent = "📢 Broadcast";
    wrap.appendChild(bcTag);
    loadBroadcastStatus(m.broadcastId).then(function(s){
      bcTag.textContent = "📢 Broadcast · " + s.readCount + "/" + s.total + " read";
    }).catch(function(){});
  }

  if(m.completed){
    var doneTag = document.createElement("div");
    doneTag.className = "done-indicator";
    var doneByName = m.completedBy ? (DEPTS[m.completedBy] ? DEPTS[m.completedBy].name : m.completedBy) : "";
    doneTag.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Done' + (doneByName ? " · " + esc(doneByName) : "");
    wrap.appendChild(doneTag);
  }

  if(m.roomNumber){
    var roomTagEl = document.createElement("div");
    roomTagEl.className = "room-msg-tag";
    roomTagEl.textContent = "🛏 Room " + m.roomNumber;
    wrap.appendChild(roomTagEl);
  }

  if(m.replyTo && msgsById && msgsById[m.replyTo]){
    var origMsg = msgsById[m.replyTo];
    var quote = document.createElement("div");
    quote.className = "reply-quote";
    quote.innerHTML =
      '<div class="reply-quote-accent"></div>'+
      '<div class="reply-quote-body">'+
        '<div class="reply-quote-name">'+esc(replySenderName(origMsg))+'</div>'+
        '<div class="reply-quote-text">'+esc(messagePreviewLabel(origMsg))+'</div>'+
      '</div>';
    quote.addEventListener("click", function(){
      var target = threadScroll.querySelector('[data-msg-id="'+origMsg.id+'"]');
      if(target){
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("flash-highlight");
        setTimeout(function(){ target.classList.remove("flash-highlight"); }, 1200);
      }
    });
    wrap.appendChild(quote);
  }

  var bubble;
  if(m.type === "text"){
    bubble = document.createElement("div");
    var iMentioned = m.mentions && AUTH.staff && m.mentions.indexOf(AUTH.staff.departmentId) !== -1;
    bubble.className = "bubble" + (iMentioned ? " mentioned-for-me" : "");
    if(m.mentions && m.mentions.length){
      bubble.innerHTML = highlightMentions(m.text, m.mentions);
    } else {
      bubble.textContent = m.text;
    }
    if(window.speechSynthesis && m.text){
      var speakBtn = document.createElement("button");
      speakBtn.type = "button";
      speakBtn.className = "read-aloud-btn";
      speakBtn.setAttribute("aria-label", "Read this message aloud");
      speakBtn.title = "Read aloud";
      speakBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
      speakBtn.addEventListener("click", function(){
        showConfirm({
          title: "Read this message aloud?",
          body: "Anyone nearby will be able to hear it.",
          confirmLabel: "Read aloud",
          neutral: true,
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>'
        }).then(function(ok){ if(ok) speakText(m.text); });
      });
      bubble.appendChild(speakBtn);
    }
  } else if(m.type === "image"){
    bubble = document.createElement("div");
    bubble.className = "bubble img-bubble";
    var src = m.img === "fridge" ? fridgeImageSrc() : m.dataUrl;
    bubble.innerHTML = '<img src="'+src+'" alt="Attached photo">' + (m.text ? '<div class="cap">'+esc(m.text)+'</div>' : '');
  } else if(m.type === "file"){
    bubble = document.createElement("div");
    bubble.className = "bubble file-bubble";
    bubble.innerHTML =
      '<div class="file-ic"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5a1 1 0 0 0 1 1h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/></svg></div>'+
      '<div class="file-meta"><b>'+esc(m.fileName)+'</b><span>'+fmtBytes(m.fileSize||0)+'</span></div>'+
      '<div class="file-download-btn" aria-label="Download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg></div>';
    if(m.url){ bubble.addEventListener("click", function(){ window.open(m.url, "_blank"); }); }
    if(m.text){
      var capRow = document.createElement("div");
      capRow.className = "bubble";
      capRow.style.marginTop = "4px";
      capRow.textContent = m.text;
    }
  } else if(m.type === "audio"){
    bubble = buildAudioNode(m);
  }
  var isEmptyPollBubble = m.poll && m.type === "text" && !m.text;
  var hideTextBubble = isEmptyPollBubble || (m.signoff && m.type === "text");
  if(!hideTextBubble){
    if(!m.deleted && !m.pending) attachLongPress(bubble, function(x, y){ showMessageActionMenu(m, x, y); });
    wrap.appendChild(bubble);
  }
  if(m.type === "audio" && m.transcript){
    var transcriptWrap = document.createElement("div");
    transcriptWrap.className = "voice-transcript-wrap";
    var transcriptToggle = document.createElement("button");
    transcriptToggle.type = "button";
    transcriptToggle.className = "voice-transcript-toggle";
    transcriptToggle.textContent = "Show transcript";
    var transcriptText = document.createElement("div");
    transcriptText.className = "voice-transcript-text";
    transcriptText.textContent = m.transcript;
    transcriptText.hidden = true;
    transcriptToggle.addEventListener("click", function(){
      transcriptText.hidden = !transcriptText.hidden;
      transcriptToggle.textContent = transcriptText.hidden ? "Show transcript" : "Hide transcript";
    });
    transcriptWrap.appendChild(transcriptToggle);
    transcriptWrap.appendChild(transcriptText);
    wrap.appendChild(transcriptWrap);
  }
  if(m.type === "file" && m.text){
    var capBubble = document.createElement("div");
    capBubble.className = "bubble";
    capBubble.style.marginTop = "4px";
    capBubble.textContent = m.text;
    wrap.appendChild(capBubble);
  }

  if(m.signoff){
    var signoffCard = buildSignoffCard(m);
    if(!m.deleted && !m.pending) attachLongPress(signoffCard, function(x, y){ showMessageActionMenu(m, x, y); });
    wrap.appendChild(signoffCard);
  }
  if(m.poll) wrap.appendChild(buildPollCard(m));

  var canInlineMeta = m.type === "text" && !hideTextBubble;
  var meta = document.createElement("div");
  if(out){
    meta.className = "msg-status" + (canInlineMeta ? " bubble-meta-inline" : "") + (m.status === "read" ? " read" : "");
    if(m.pending){
      var pendingLabel = document.createElement("span");
      pendingLabel.className = "pending-label";
      pendingLabel.textContent = "Sending…";
      meta.appendChild(pendingLabel);
    } else {
      var timeSpan = document.createElement("span");
      timeSpan.textContent = (m.edited ? "Edited · " : "") + fmtClock(m.t);
      var ticks = document.createElement("span");
      ticks.className = "ticks";
      ticks.innerHTML = TICK_SVG;
      meta.appendChild(timeSpan);
      meta.appendChild(ticks);
    }
  } else {
    meta.className = "msg-time" + (canInlineMeta ? " bubble-meta-inline" : "");
    var timeSpan2 = document.createElement("span");
    timeSpan2.textContent = (m.edited ? "Edited · " : "") + fmtClock(m.t);
    meta.appendChild(timeSpan2);
  }
  if(canInlineMeta) bubble.appendChild(meta); else wrap.appendChild(meta);

  var pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "msg-pin-btn" + (m.pinned ? " pinned" : "");
  pinBtn.setAttribute("aria-label", m.pinned ? "Unpin message" : "Pin message");
  pinBtn.title = m.pinned ? "Unpin" : "Pin";
  pinBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M8 3h8l-1 7 3 3H6l3-3-1-7z"/></svg>';
  pinBtn.addEventListener("click", function(e){ e.stopPropagation(); togglePinMessage(m); });
  if(out){ row.appendChild(pinBtn); row.appendChild(wrap); } else { row.appendChild(wrap); row.appendChild(pinBtn); }
  return row;
}

function confirmDeleteMessage(id){
  showConfirm({
    title: "Delete this message?",
    body: "It will be hidden from this conversation, but it is not erased. Management can still see the original message."
  }).then(function(ok){
    if(!ok) return;
    apiDelete('/api/messages/' + encodeURIComponent(id)).then(function(res){
      var msgs = currentMessagesArray();
      var idx = msgs.findIndex(function(x){ return x.id === id; });
      if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
      renderList();
      renderThread();
    }).catch(function(){
      showToast("Couldn't delete that message");
    });
  });
}

/* ---------------- Identity switching ---------------- */
function loadMutedList(){
  return apiGet('/api/muted?self=' + encodeURIComponent(STATE.self)).then(function(res){
    STATE.muted = {};
    (res.muted || []).forEach(function(id){ STATE.muted[id] = true; });
  }).catch(function(){});
}

function switchSelf(id){
  if(id === STATE.self || STATE.loading) return;
  STATE.self = id;
  STATE.loading = true;
  STATE.threadOpened = false;
  renderSwitcher();
  renderMyProfileCard();
  updateComposerLock();
  Promise.all([buildData(id), loadMutedList()]).then(function(results){
    STATE.data = results[0];
    var order = sortedDeptIds();
    STATE.active = order[0];
    renderList();
    renderHeader();
    markRead(STATE.active);
    renderList();
    renderThread();
    renderDuty();
    focusInput();
  }).finally(function(){ STATE.loading = false; });
}

function activeGroupIsArchived(){
  if(!STATE.activeGroupId) return false;
  var g = STATE.groups.find(function(x){ return x.id === STATE.activeGroupId; });
  return !!(g && g.archivedAt);
}

function isViewOnly(){
  if(STATE.activeGroupId) return activeGroupIsArchived();
  return !!(AUTH.staff && AUTH.staff.isAdmin && STATE.self !== AUTH.staff.departmentId);
}

function updateComposerLock(){
  var locked = isViewOnly();
  composer.hidden = locked;
  composerLocked.hidden = !locked;
  if(locked){
    if(STATE.activeGroupId){
      composerLocked.innerHTML = "This event has ended and is now read only, kept here for training.";
      return;
    }
    var viewing = DEPTS[STATE.self] ? DEPTS[STATE.self].name : "this department";
    var home = DEPTS[AUTH.staff.departmentId] ? DEPTS[AUTH.staff.departmentId].name : "your department";
    composerLocked.innerHTML = "Viewing <b>" + esc(viewing) + "</b>'s messages (read only). Switch back to <b>" + esc(home) + "</b> to send.";
  }
}

/* ---------------- Off duty toggle ---------------- */
function isOnDuty(id){ var meta = DEPT_META[id]; return !meta || meta.onDuty !== false; }
function setOnDuty(id, on){
  if(!DEPT_META[id]) DEPT_META[id] = { id: id };
  DEPT_META[id].onDuty = on;
  apiSend('/api/departments/' + encodeURIComponent(id), 'PATCH', { onDuty: on }).catch(function(){});
}

var dutyTrack = document.getElementById("dutyTrack");
var dutyKnob = document.getElementById("dutyKnob");

function dutyMaxLeft(){ return dutyTrack.clientWidth - 27 - 4; }

function renderDuty(){
  var on = isOnDuty(STATE.self);
  dutyTrack.classList.toggle("off", !on);
  dutyKnob.style.left = (on ? 2 : dutyMaxLeft() + 2) + "px";
  dutyKnob.setAttribute("aria-checked", on ? "true" : "false");
  dutyKnob.setAttribute("aria-label", on ? "On duty. Slide or press Enter to turn the board off" : "Board off. Slide or press Enter to turn it back on");
}

(function(){
  var dragging = false, startX = 0, startLeft = 2, moved = false;

  function clamp(v){ return Math.min(dutyMaxLeft() + 2, Math.max(2, v)); }

  function onDown(e){
    dragging = true; moved = false;
    dutyKnob.setPointerCapture(e.pointerId);
    dutyTrack.classList.add("dragging");
    startX = e.clientX;
    startLeft = parseFloat(dutyKnob.style.left) || 2;
  }
  function onMove(e){
    if(!dragging) return;
    var dx = e.clientX - startX;
    if(Math.abs(dx) > 3) moved = true;
    dutyKnob.style.left = clamp(startLeft + dx) + "px";
  }
  function onUp(){
    if(!dragging) return;
    dragging = false;
    dutyTrack.classList.remove("dragging");
    var left = parseFloat(dutyKnob.style.left) || 2;
    var pct = (left - 2) / dutyMaxLeft();
    var wasOn = isOnDuty(STATE.self);
    var flip = wasOn ? pct > 0.55 : pct < 0.45;
    if(flip && moved) setOnDuty(STATE.self, !wasOn);
    renderDuty();
  }
  dutyKnob.addEventListener("pointerdown", onDown);
  dutyKnob.addEventListener("pointermove", onMove);
  dutyKnob.addEventListener("pointerup", onUp);
  dutyKnob.addEventListener("pointercancel", onUp);
  dutyKnob.addEventListener("keydown", function(e){
    if(e.key === "Enter" || e.key === " "){
      e.preventDefault();
      setOnDuty(STATE.self, !isOnDuty(STATE.self));
      renderDuty();
    }
  });
  window.addEventListener("resize", function(){ if(!dragging) renderDuty(); });
})();

/* ---------------- Composer ---------------- */
var msgInput = document.getElementById("msgInput");
var sendBtn = document.getElementById("sendBtn");
var plusBtn = document.getElementById("plusBtn");
var plusMenu = document.getElementById("plusMenu");
var optPhoto = document.getElementById("optPhoto");
var optCamera = document.getElementById("optCamera");
var micQuickBtn = document.getElementById("micQuickBtn");
var urgentToggleBtn = document.getElementById("urgentToggleBtn");
var optAffectsGuest = document.getElementById("optAffectsGuest");
var optRoom = document.getElementById("optRoom");
var optTask = document.getElementById("optTask");
var optSignoff = document.getElementById("optSignoff");
var fileInput = document.getElementById("fileInput");
var cameraInput = document.getElementById("cameraInput");
var attachPreviewHost = document.getElementById("attachPreview");
var composer = document.getElementById("composer");
var composerLocked = document.getElementById("composerLocked");
var composerIdle = document.getElementById("composerIdle");
var composerRecording = document.getElementById("composerRecording");
var composerVoicePreview = document.getElementById("composerVoicePreview");
var recTimer = document.getElementById("recTimer");
var recBars = document.getElementById("recBars");
var recCancel = document.getElementById("recCancel");
var recStop = document.getElementById("recStop");
var vpTrash = document.getElementById("vpTrash");
var vpSend = document.getElementById("vpSend");
var vpAudio = document.getElementById("vpAudio");
var urgentActive = false;
var affectsGuestActive = false;
var taskActive = false;

for(var i=0;i<22;i++){
  var s = document.createElement("span");
  s.style.animationDelay = (i*0.045)+"s";
  recBars.appendChild(s);
}

function focusInput(){ setTimeout(function(){ try{ msgInput.focus(); }catch(e){} }, 30); }

function autoGrow(){
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(120, msgInput.scrollHeight) + "px";
}
msgInput.addEventListener("input", function(){ autoGrow(); refreshSendState(); notifyTyping(); updateMentionPopover(); });
msgInput.addEventListener("keydown", function(e){
  if(e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    doSend();
  }
});
msgInput.addEventListener("click", updateMentionPopover);
msgInput.addEventListener("blur", function(){ setTimeout(function(){ mentionPopover.hidden = true; }, 150); });

var mentionPopover = document.getElementById("mentionPopover");
function updateMentionPopover(){
  if(!STATE.activeGroupId){ mentionPopover.hidden = true; return; }
  var val = msgInput.value;
  var caret = msgInput.selectionStart;
  var uptoCaret = val.slice(0, caret);
  var match = uptoCaret.match(/@([a-zA-Z ]*)$/);
  if(!match){ mentionPopover.hidden = true; return; }
  var term = match[1].toLowerCase();
  var g = STATE.groups.find(function(x){ return x.id === STATE.activeGroupId; });
  if(!g){ mentionPopover.hidden = true; return; }
  var candidates = g.members.filter(function(id){ return id !== STATE.self; }).map(function(id){
    return { id: id, name: DEPTS[id] ? DEPTS[id].name : id };
  }).filter(function(c){ return c.name.toLowerCase().indexOf(term) !== -1; });
  if(!candidates.length){ mentionPopover.hidden = true; return; }
  mentionPopover.innerHTML = candidates.map(function(c){
    return '<button type="button" class="mention-popover-opt" data-dept="'+c.id+'">'+
      '<span class="fwd-avatar" style="'+avatarStyleAttr(c.id)+'">'+avatarInnerHtml(c.id)+'</span>'+esc(c.name)+'</button>';
  }).join("");
  mentionPopover.hidden = false;
  mentionPopover.querySelectorAll(".mention-popover-opt").forEach(function(btn){
    btn.addEventListener("click", function(){
      var deptId = btn.getAttribute("data-dept");
      var name = DEPTS[deptId] ? DEPTS[deptId].name : deptId;
      var before = val.slice(0, caret - match[0].length);
      var after = val.slice(caret);
      var inserted = "@" + name + " ";
      msgInput.value = before + inserted + after;
      var newCaret = before.length + inserted.length;
      msgInput.focus();
      msgInput.setSelectionRange(newCaret, newCaret);
      autoGrow();
      refreshSendState();
      mentionPopover.hidden = true;
    });
  });
}

function extractMentions(text, groupId){
  if(!groupId || !text) return [];
  var g = STATE.groups.find(function(x){ return x.id === groupId; });
  if(!g) return [];
  var lower = text.toLowerCase();
  var mentions = [];
  g.members.forEach(function(deptId){
    if(deptId === STATE.self) return;
    var name = DEPTS[deptId] ? DEPTS[deptId].name : deptId;
    if(lower.indexOf("@" + name.toLowerCase()) !== -1) mentions.push(deptId);
  });
  return mentions;
}

function refreshSendState(){
  var ready = msgInput.value.trim().length > 0 || !!STATE.attachment;
  sendBtn.classList.toggle("ready", ready);
  sendBtn.classList.toggle("urgent", ready && urgentActive);
  micQuickBtn.classList.toggle("hide", ready);
}

function closePlusMenu(){
  plusMenu.classList.remove("open");
  plusBtn.classList.remove("open");
  plusBtn.setAttribute("aria-expanded", "false");
}
function openPlusMenu(){
  plusMenu.classList.add("open");
  plusBtn.classList.add("open");
  plusBtn.setAttribute("aria-expanded", "true");
}
plusBtn.addEventListener("click", function(){
  if(plusMenu.classList.contains("open")) closePlusMenu(); else openPlusMenu();
});
document.addEventListener("click", function(e){
  if(!plusMenu.contains(e.target) && e.target !== plusBtn && !plusBtn.contains(e.target)){
    closePlusMenu();
  }
});

var qrBtn = document.getElementById("qrBtn");
var qrMenu = document.getElementById("qrMenu");
var qrChipList = document.getElementById("qrChipList");
var qrEditToggle = document.getElementById("qrEditToggle");
var qrAddChip = document.getElementById("qrAddChip");
var qrEditMode = false;
STATE.quickReplies = [];

function loadQuickReplies(){
  return apiGet('/api/quick-replies').then(function(res){
    STATE.quickReplies = res.replies;
    renderQuickReplies();
  }).catch(function(){});
}

function sendQuickReply(text){
  closeQrMenu();
  msgInput.value = text;
  autoGrow();
  refreshSendState();
  doSend();
}

function editQuickReply(r){
  showPrompt({ title: "Edit quick reply", value: r.text, maxLength: 24, confirmLabel: "Save" }).then(function(next){
    if(next === null) return;
    next = next.trim();
    if(!next){ removeQuickReply(r.id); return; }
    next = next.slice(0, 24);
    apiSend('/api/quick-replies/' + encodeURIComponent(r.id), 'PATCH', { text: next }).then(function(res){
      var idx = STATE.quickReplies.findIndex(function(x){ return x.id === r.id; });
      if(idx !== -1) STATE.quickReplies[idx] = res.reply;
      renderQuickReplies();
    }).catch(function(err){ showToast(err.message || "Couldn't update that"); });
  });
}

function removeQuickReply(id){
  var idx = STATE.quickReplies.findIndex(function(x){ return x.id === id; });
  var removed = idx !== -1 ? STATE.quickReplies.splice(idx, 1)[0] : null;
  renderQuickReplies();
  apiDelete('/api/quick-replies/' + encodeURIComponent(id)).catch(function(){
    if(removed){ STATE.quickReplies.splice(idx, 0, removed); renderQuickReplies(); }
    showToast("Couldn't remove that");
  });
}

function renderQuickReplies(){
  qrChipList.innerHTML = "";
  STATE.quickReplies.forEach(function(r){
    if(qrEditMode){
      var row = document.createElement("div");
      row.className = "qr-chip-row";
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "qr-chip";
      chip.textContent = r.text;
      chip.addEventListener("click", function(){ editQuickReply(r); });
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "qr-chip-remove";
      rm.textContent = "−";
      rm.setAttribute("aria-label", "Remove");
      rm.addEventListener("click", function(e){ e.stopPropagation(); removeQuickReply(r.id); });
      row.appendChild(chip);
      row.appendChild(rm);
      qrChipList.appendChild(row);
    } else {
      var plain = document.createElement("button");
      plain.type = "button";
      plain.className = "qr-chip";
      plain.textContent = r.text;
      plain.addEventListener("click", function(){ sendQuickReply(r.text); });
      qrChipList.appendChild(plain);
    }
  });
}

qrAddChip.addEventListener("click", function(){
  showPrompt({ title: "Add a quick reply", placeholder: "Max 24 characters", maxLength: 24, confirmLabel: "Add" }).then(function(text){
    if(!text) return;
    text = text.trim();
    if(!text) return;
    text = text.slice(0, 24);
    apiSend('/api/quick-replies', 'POST', { text: text }).then(function(res){
      STATE.quickReplies.push(res.reply);
      renderQuickReplies();
    }).catch(function(err){ showToast(err.message || "Couldn't add that"); });
  });
});

qrEditToggle.addEventListener("click", function(){
  qrEditMode = !qrEditMode;
  qrEditToggle.textContent = qrEditMode ? "Done" : "Edit";
  qrEditToggle.classList.toggle("active", qrEditMode);
  renderQuickReplies();
});

function closeQrMenu(){
  qrMenu.classList.remove("open");
  qrBtn.classList.remove("open");
  qrBtn.setAttribute("aria-expanded", "false");
}
function openQrMenu(){
  qrMenu.classList.add("open");
  qrBtn.classList.add("open");
  qrBtn.setAttribute("aria-expanded", "true");
  loadQuickReplies();
}
qrBtn.addEventListener("click", function(){
  if(qrMenu.classList.contains("open")) closeQrMenu(); else openQrMenu();
});
document.addEventListener("click", function(e){
  if(!qrMenu.contains(e.target) && e.target !== qrBtn && !qrBtn.contains(e.target)){
    closeQrMenu();
  }
});

optPhoto.addEventListener("click", function(){ closePlusMenu(); fileInput.click(); });
optCamera.addEventListener("click", function(){ closePlusMenu(); cameraInput.click(); });
micQuickBtn.addEventListener("click", function(){ startRecording(); });
urgentToggleBtn.addEventListener("click", function(){
  urgentActive = !urgentActive;
  urgentToggleBtn.classList.toggle("active", urgentActive);
  composer.classList.toggle("urgent-mode", urgentActive);
  refreshSendState();
});
optAffectsGuest.addEventListener("click", function(){
  affectsGuestActive = !affectsGuestActive;
  optAffectsGuest.classList.toggle("active", affectsGuestActive);
  closePlusMenu();
});
optRoom.addEventListener("click", function(){
  closePlusMenu();
  showRoomTagBar();
});
optTask.addEventListener("click", function(){
  setTaskActive(!taskActive);
  closePlusMenu();
});
optSignoff.addEventListener("click", function(){
  closePlusMenu();
  openSignoffOverlay();
});
var optAssetRequest = document.getElementById("optAssetRequest");
optAssetRequest.addEventListener("click", function(){
  closePlusMenu();
  openAssetsOverlay(true);
});

var optPoll = document.getElementById("optPoll");
var pollComposeOverlay = document.getElementById("pollComposeOverlay");
var pollComposeClose = document.getElementById("pollComposeClose");
var pollComposeForm = document.getElementById("pollComposeForm");
var pollQuestionInput = document.getElementById("pollQuestionInput");
var pollOptionsList = document.getElementById("pollOptionsList");
var pollAddOptionBtn = document.getElementById("pollAddOptionBtn");
var pollComposeError = document.getElementById("pollComposeError");
var pollComposeSubmit = document.getElementById("pollComposeSubmit");
function addPollOptionInput(){
  var count = pollOptionsList.querySelectorAll(".poll-option-input").length;
  if(count >= 4) return;
  var input = document.createElement("input");
  input.type = "text";
  input.className = "poll-option-input";
  input.maxLength = 60;
  input.placeholder = "Option " + (count + 1);
  pollOptionsList.appendChild(input);
  pollAddOptionBtn.hidden = pollOptionsList.querySelectorAll(".poll-option-input").length >= 4;
}
function openPollComposeOverlay(){
  pollQuestionInput.value = "";
  pollOptionsList.innerHTML = "";
  addPollOptionInput();
  addPollOptionInput();
  pollComposeError.textContent = "";
  pollComposeSubmit.disabled = false;
  pollComposeOverlay.hidden = false;
}
optPoll.addEventListener("click", function(){
  closePlusMenu();
  openPollComposeOverlay();
});
pollAddOptionBtn.addEventListener("click", addPollOptionInput);
pollComposeClose.addEventListener("click", function(){ pollComposeOverlay.hidden = true; });
pollComposeOverlay.addEventListener("click", function(e){ if(e.target === pollComposeOverlay) pollComposeOverlay.hidden = true; });
pollComposeForm.addEventListener("submit", function(e){
  e.preventDefault();
  var question = pollQuestionInput.value.trim();
  var options = Array.prototype.map.call(pollOptionsList.querySelectorAll(".poll-option-input"), function(inp){ return inp.value.trim(); }).filter(Boolean);
  if(!question){ pollComposeError.textContent = "A question is required."; return; }
  if(options.length < 2){ pollComposeError.textContent = "Add at least 2 options."; return; }
  pollComposeSubmit.disabled = true;
  pollComposeError.textContent = "";
  var groupId = STATE.activeGroupId;
  var deptId = STATE.active;
  var payload = { from: STATE.self, type: "text", poll: { question: question, options: options } };
  if(groupId) payload.groupId = groupId; else payload.to = deptId;
  apiSend('/api/messages', 'POST', payload).then(function(res){
    if(groupId){
      STATE.groupMessages[groupId] = STATE.groupMessages[groupId] || [];
      STATE.groupMessages[groupId].push(mapServerMessage(res.message, STATE.self));
      if(STATE.activeGroupId === groupId) renderThread();
    } else {
      STATE.data[deptId] = STATE.data[deptId] || [];
      STATE.data[deptId].push(mapServerMessage(res.message, STATE.self));
      renderList();
      if(STATE.active === deptId) renderThread();
    }
    pollComposeOverlay.hidden = true;
  }).catch(function(err){
    pollComposeError.textContent = err.message || "Couldn't create that poll.";
  }).then(function(){
    pollComposeSubmit.disabled = false;
  });
});

function handleAttachedFile(file){
  if(!file) return;
  if(file.type.indexOf("image/") === 0){
    var reader = new FileReader();
    reader.onload = function(){
      STATE.attachment = { type:"image", dataUrl: reader.result, name:file.name, file:file, mime:file.type };
      renderAttachPreview();
      refreshSendState();
    };
    reader.readAsDataURL(file);
  } else {
    STATE.attachment = { type:"file", url: URL.createObjectURL(file), name:file.name, size:file.size, file:file, mime:file.type };
    renderAttachPreview();
    refreshSendState();
  }
}
fileInput.addEventListener("change", function(e){
  var file = e.target.files[0];
  fileInput.value = "";
  handleAttachedFile(file);
});
cameraInput.addEventListener("change", function(e){
  var file = e.target.files[0];
  cameraInput.value = "";
  handleAttachedFile(file);
});

function renderAttachPreview(){
  attachPreviewHost.innerHTML = "";
  if(!STATE.attachment) return;
  var a = STATE.attachment;
  var el = document.createElement("div");
  el.className = "attach-preview";
  if(a.type === "image"){
    el.innerHTML = '<img src="'+a.dataUrl+'" alt="">'+
      '<div class="ap-meta"><b>'+esc(a.name)+'</b><span>Photo</span></div>'+
      '<button class="ap-remove" aria-label="Remove attachment"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  } else {
    el.innerHTML = '<div class="file-ic" style="background:var(--accent)"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5a1 1 0 0 0 1 1h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/></svg></div>'+
      '<div class="ap-meta"><b>'+esc(a.name)+'</b><span>'+fmtBytes(a.size||0)+'</span></div>'+
      '<button class="ap-remove" aria-label="Remove attachment"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  }
  el.querySelector(".ap-remove").addEventListener("click", function(){
    STATE.attachment = null;
    renderAttachPreview();
    refreshSendState();
  });
  attachPreviewHost.appendChild(el);
}

/* ---- send ---- */
var composerHint = document.getElementById("composerHint");
var hintDefault = composerHint.textContent;
var hintTimer = null;
function blockForLanguage(){
  clearTimeout(hintTimer);
  composerHint.textContent = "Let's keep it professional. That message can't be sent.";
  composerHint.classList.add("warn");
  composer.classList.remove("shake");
  void composer.offsetWidth;
  composer.classList.add("shake");
  hintTimer = setTimeout(function(){
    composerHint.textContent = hintDefault;
    composerHint.classList.remove("warn");
  }, 2800);
}

/* ---------------- Offline queue ---------------- */
function offlineQueueKey(){ return "hp_offline_queue_" + (AUTH.staff ? AUTH.staff.id : "anon"); }
function loadOfflineQueue(){
  try{ return JSON.parse(localStorage.getItem(offlineQueueKey()) || "[]"); }catch(e){ return []; }
}
function saveOfflineQueue(q){
  try{ localStorage.setItem(offlineQueueKey(), JSON.stringify(q)); }catch(e){}
}
function pendingMessageFromQueueItem(item){
  return {
    id: item.localId, from: "self", to: item.deptId, type: "text",
    urgent: !!item.payload.urgent, t: item.queuedAt, read: false, status: "pending",
    replyTo: item.payload.replyToId || undefined, pinned: false, completed: false,
    deleted: false, pending: true, roomNumber: item.payload.roomNumber || undefined,
    taskStatus: item.payload.taskStatus || undefined,
    signoff: item.payload.signoff ? Object.assign({ status: "pending" }, item.payload.signoff) : undefined
  };
}
function queueOfflineMessage(deptId, payload){
  var q = loadOfflineQueue();
  var localId = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  var item = { localId: localId, deptId: deptId, payload: payload, queuedAt: Date.now() };
  q.push(item);
  saveOfflineQueue(q);
  STATE.data[deptId] = STATE.data[deptId] || [];
  STATE.data[deptId].push(pendingMessageFromQueueItem(item));
  renderList();
  if(STATE.active === deptId) renderThread();
  showToast("No connection. That'll send automatically once you're back online.");
}
function mergePendingIntoData(data){
  loadOfflineQueue().forEach(function(item){
    data[item.deptId] = data[item.deptId] || [];
    var exists = data[item.deptId].some(function(x){ return x.id === item.localId; });
    if(!exists) data[item.deptId].push(pendingMessageFromQueueItem(item));
  });
  return data;
}
var offlineFlushInFlight = false;
function flushOfflineQueue(){
  if(offlineFlushInFlight) return Promise.resolve();
  var q = loadOfflineQueue();
  if(!q.length) return Promise.resolve();
  offlineFlushInFlight = true;
  function next(i){
    if(i >= q.length){ offlineFlushInFlight = false; return Promise.resolve(); }
    var item = q[i];
    return apiSend('/api/messages', 'POST', item.payload).then(function(res){
      saveOfflineQueue(loadOfflineQueue().filter(function(x){ return x.localId !== item.localId; }));
      var msgs = STATE.data[item.deptId] || [];
      var idx = msgs.findIndex(function(x){ return x.id === item.localId; });
      var real = mapServerMessage(res.message, STATE.self);
      if(idx !== -1) msgs[idx] = real; else msgs.push(real);
      renderList();
      if(STATE.active === item.deptId) renderThread();
      return next(i + 1);
    }).catch(function(){
      offlineFlushInFlight = false;
    });
  }
  return next(0);
}
window.addEventListener("online", flushOfflineQueue);

function saveEditedMessage(){
  var text = msgInput.value.trim();
  if(!text) return;
  if(containsProfanity(text)){ blockForLanguage(); return; }
  var m = STATE.editingMessage;
  msgInput.value = "";
  autoGrow();
  clearEditBar();
  refreshSendState();
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/edit', 'POST', { text: text }).then(function(res){
    var msgs = currentMessagesArray();
    var idx = msgs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
    renderThread();
    showToast("Message updated");
  }).catch(function(){ showToast("Couldn't save changes"); });
}

function doSend(){
  if(STATE.editingMessage) return saveEditedMessage();
  var text = msgInput.value.trim();
  if(!text && !STATE.attachment) return;
  if(text && containsProfanity(text)){ blockForLanguage(); return; }
  mentionPopover.hidden = true;
  var deptId = STATE.active;
  var groupId = STATE.activeGroupId;
  var attachment = STATE.attachment;
  var wasUrgent = urgentActive;
  var wasAffectsGuest = affectsGuestActive;
  var wasTask = taskActive;
  var wasSignoff = signoffActive;
  var signoffPayload = signoffData;

  msgInput.value = "";
  autoGrow();
  STATE.attachment = null;
  renderAttachPreview();
  urgentActive = false;
  urgentToggleBtn.classList.remove("active");
  composer.classList.remove("urgent-mode");
  affectsGuestActive = false;
  optAffectsGuest.classList.remove("active");
  refreshSendState();

  var payload = { from: STATE.self, urgent: wasUrgent, affectsGuest: wasAffectsGuest };
  if(groupId){ payload.groupId = groupId; payload.mentions = extractMentions(text, groupId); } else payload.to = deptId;
  if(STATE.replyingTo) payload.replyToId = STATE.replyingTo.id;
  clearReplyBar();
  var roomTag = roomTagInput.value.trim();
  if(roomTag) payload.roomNumber = roomTag;
  clearRoomTagBar();
  if(wasTask && !groupId) payload.taskStatus = "not_started";
  setTaskActive(false);
  if(wasSignoff && !groupId && signoffPayload) payload.signoff = signoffPayload;
  clearSignoffTag();
  var sendPromise;
  if(attachment && attachment.type === "image"){
    payload.type = "image"; payload.text = text; payload.fileName = attachment.name;
    sendPromise = blobToBase64(attachment.file).then(function(b64){
      payload.fileBase64 = b64; payload.fileMime = attachment.mime;
      return apiSend('/api/messages', 'POST', payload);
    });
  } else if(attachment && attachment.type === "file"){
    payload.type = "file"; payload.text = text; payload.fileName = attachment.name;
    sendPromise = blobToBase64(attachment.file).then(function(b64){
      payload.fileBase64 = b64; payload.fileMime = attachment.mime;
      return apiSend('/api/messages', 'POST', payload);
    });
  } else {
    payload.type = "text"; payload.text = text;
    sendPromise = apiSend('/api/messages', 'POST', payload);
  }

  sendPromise.then(function(res){
    if(groupId){
      STATE.groupMessages[groupId] = STATE.groupMessages[groupId] || [];
      STATE.groupMessages[groupId].push(mapServerMessage(res.message, STATE.self));
      if(STATE.activeGroupId === groupId) renderThread();
    } else {
      STATE.data[deptId] = STATE.data[deptId] || [];
      STATE.data[deptId].push(mapServerMessage(res.message, STATE.self));
      renderList();
      if(STATE.active === deptId) renderThread();
    }
  }).catch(function(err){
    if(!attachment && !groupId && (err instanceof TypeError || !navigator.onLine)){
      queueOfflineMessage(deptId, payload);
      return;
    }
    blockForLanguage();
    composerHint.textContent = "That message didn't send. Check your connection and try again.";
  });
}
sendBtn.addEventListener("click", doSend);

/* ---- voice recording ---- */
function setComposerState(s){
  STATE.composer = s;
  composerIdle.hidden = s !== "idle";
  composerRecording.hidden = s !== "recording";
  composerVoicePreview.hidden = s !== "voice-preview";
}


function startRecording(){
  STATE.recChunks = [];
  STATE.recTranscript = "";
  var onStream = function(stream, isSynth, cleanup){
    STATE.recStream = stream;
    STATE.synthCleanup = cleanup || null;
    try{
      STATE.mediaRecorder = new MediaRecorder(stream);
    }catch(e){
      setComposerState("idle");
      return;
    }
    STATE.mediaRecorder.ondataavailable = function(e){ if(e.data.size>0) STATE.recChunks.push(e.data); };
    STATE.mediaRecorder.start();
    STATE.recStart = Date.now();
    setComposerState("recording");
    tickTimer();
    if(!isSynth) startTranscription();
  };

  if(navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      onStream(stream, false, null);
    }).catch(function(){
      synthFallback(onStream);
    });
  } else {
    synthFallback(onStream);
  }
}

function startTranscription(){
  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!Recognition) return;
  try{
    var rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-GB";
    rec.onresult = function(e){
      var text = "";
      for(var i=0;i<e.results.length;i++) text += e.results[i][0].transcript;
      STATE.recTranscript = text.trim();
    };
    rec.onerror = function(){};
    rec.start();
    STATE.recRecognition = rec;
  }catch(e){ STATE.recRecognition = null; }
}

function stopTranscription(){
  if(STATE.recRecognition){
    try{ STATE.recRecognition.stop(); }catch(e){}
    STATE.recRecognition = null;
  }
}

function synthFallback(onStream){
  try{
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    var dest = ctx.createMediaStreamDestination();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = 180;
    gain.gain.value = 0.0018;
    osc.connect(gain).connect(dest);
    osc.start();
    onStream(dest.stream, true, function(){ try{osc.stop(); ctx.close();}catch(e){} });
  }catch(e){
    setComposerState("idle");
  }
}

function tickTimer(){
  clearInterval(STATE.recTimerId);
  STATE.recTimerId = setInterval(function(){
    var s = Math.floor((Date.now() - STATE.recStart)/1000);
    var m = Math.floor(s/60), r = s%60;
    recTimer.textContent = m+":"+(r<10?"0":"")+r;
  }, 200);
}

function finishRecording(cancel){
  return new Promise(function(resolve){
    if(!STATE.mediaRecorder){ resolve(null); return; }
    STATE.mediaRecorder.onstop = function(){
      clearInterval(STATE.recTimerId);
      stopTranscription();
      if(STATE.recStream){ STATE.recStream.getTracks().forEach(function(t){ t.stop(); }); }
      if(STATE.synthCleanup){ STATE.synthCleanup(); STATE.synthCleanup = null; }
      if(cancel){ setComposerState("idle"); resolve(null); return; }
      var blob = new Blob(STATE.recChunks, {type: STATE.recChunks[0] ? STATE.recChunks[0].type : "audio/webm"});
      var url = URL.createObjectURL(blob);
      var duration = Math.max(1, Math.round((Date.now() - STATE.recStart)/1000));
      STATE.voice = { url: url, duration: duration, transcript: STATE.recTranscript || null };
      resolve(STATE.voice);
    };
    try{ STATE.mediaRecorder.stop(); }catch(e){ resolve(null); }
  });
}

recCancel.addEventListener("click", function(){ finishRecording(true); });
recStop.addEventListener("click", function(){
  finishRecording(false).then(function(v){
    if(v){
      setComposerState("voice-preview");
      renderVoicePreview();
    }
  });
});

function renderVoicePreview(){
  vpAudio.innerHTML = "";
  vpAudio.style.flexDirection = "column";
  vpAudio.style.alignItems = "stretch";
  var node = buildAudioNode({ url: STATE.voice.url, duration: STATE.voice.duration });
  node.classList.remove("bubble","audio-bubble");
  node.style.display = "flex"; node.style.alignItems = "center"; node.style.gap = "8px"; node.style.width = "100%";
  vpAudio.appendChild(node);
  if(STATE.voice.transcript){
    var t = document.createElement("div");
    t.className = "vp-transcript-preview";
    t.textContent = STATE.voice.transcript;
    vpAudio.appendChild(t);
  }
}

vpTrash.addEventListener("click", function(){
  STATE.voice = null;
  setComposerState("idle");
});
vpSend.addEventListener("click", function(){
  if(!STATE.voice) return;
  var deptId = STATE.active;
  var groupId = STATE.activeGroupId;
  var voice = STATE.voice;
  var replyToId = STATE.replyingTo ? STATE.replyingTo.id : null;
  clearReplyBar();
  STATE.voice = null;
  setComposerState("idle");

  fetch(voice.url).then(function(r){ return r.blob(); }).then(function(blob){
    return blobToBase64(blob).then(function(b64){
      var payload = {
        from: STATE.self, type: "audio",
        fileBase64: b64, fileMime: blob.type || "audio/webm",
        duration: voice.duration, transcript: voice.transcript || null
      };
      if(groupId) payload.groupId = groupId; else payload.to = deptId;
      if(replyToId) payload.replyToId = replyToId;
      return apiSend('/api/messages', 'POST', payload);
    });
  }).then(function(res){
    if(groupId){
      STATE.groupMessages[groupId] = STATE.groupMessages[groupId] || [];
      STATE.groupMessages[groupId].push(mapServerMessage(res.message, STATE.self));
      if(STATE.activeGroupId === groupId) renderThread();
    } else {
      STATE.data[deptId] = STATE.data[deptId] || [];
      STATE.data[deptId].push(mapServerMessage(res.message, STATE.self));
      renderList();
      if(STATE.active === deptId) renderThread();
    }
  }).catch(function(){
    composerHint.textContent = "That voice note didn't send. Check your connection and try again.";
  });
});

/* ---- mobile back ---- */
document.getElementById("backBtn").addEventListener("click", function(){
  if(history.state && history.state.dashThread){
    history.back();
  } else {
    closeThreadView();
  }
});

/* ---------------- Boot ---------------- */
function bootCacheKey(){ return "hp_boot_cache_" + STATE.self; }
function loadBootCache(){
  try{ return JSON.parse(localStorage.getItem(bootCacheKey()) || "null"); }catch(e){ return null; }
}
function saveBootCache(){
  try{
    localStorage.setItem(bootCacheKey(), JSON.stringify({ data: STATE.data, deptMeta: DEPT_META, muted: STATE.muted }));
  }catch(e){}
}
function renderBooted(){
  var order = DEPT_ORDER.filter(function(id){ return id !== STATE.self; });
  STATE.active = order[0];
  renderSwitcher();
  renderMyProfileCard();
  updateComposerLock();
  markRead(STATE.active);
  renderList();
  renderHeader();
  renderThread();
  refreshSendState();
  renderDuty();
  if(window.innerWidth > 720){
    document.querySelector(".main").classList.add("show-mobile");
  }
}
function boot(){
  var __bootT0 = performance.now();
  console.log("[PERF] boot-start", (__bootT0 - __perfT0).toFixed(1) + "ms after script-start");
  STATE.loading = true;
  var cache = loadBootCache();
  if(cache && cache.data){
    // Show last-known messages instantly (stale-while-revalidate) so the
    // list never has to sit on a bare loading state while fresh data loads.
    STATE.data = cache.data;
    Object.keys(cache.deptMeta || {}).forEach(function(id){ DEPT_META[id] = cache.deptMeta[id]; });
    STATE.muted = cache.muted || {};
    renderBooted();
    perfLogAfterPaint("boot: cached-data painted", __perfT0);
  } else {
    renderList();
  }
  Promise.all([loadDepartmentMeta(), loadStaffMeta(), buildData(STATE.self), loadMutedList()]).then(function(results){
    STATE.data = mergePendingIntoData(results[2]);
    flushOfflineQueue();
    renderBooted();
    saveBootCache();
    perfLogAfterPaint("boot: fresh-data painted (full startup)", __perfT0);
  }).finally(function(){ STATE.loading = false; });
}

var pollTimer = null;
function messagesChangeSignature(msgs){
  return msgs.map(function(m){
    return m.id+":"+m.status+":"+(m.edited?1:0)+":"+(m.deleted?1:0)+":"+(m.taskStatus||"")+":"+(m.completed?1:0)+":"+(m.pinned?1:0)+":"+(m.signoff?JSON.stringify(m.signoff):"")+":"+(m.poll?JSON.stringify(m.poll):"");
  }).join("|");
}
function refreshNow(){
  if(STATE.loading) return Promise.resolve();
  var prevIds = {};
  Object.keys(STATE.data).forEach(function(id){
    prevIds[id] = {};
    (STATE.data[id] || []).forEach(function(m){ prevIds[id][m.id] = true; });
  });
  var dutyBefore = {};
  Object.keys(DEPT_META).forEach(function(id){ dutyBefore[id] = isOnDuty(id); });
  return loadDepartmentMeta().then(function(){
    var dutyChanged = Object.keys(DEPT_META).some(function(id){ return dutyBefore[id] !== isOnDuty(id); });
    if(dutyChanged){ renderList(); renderHeader(); renderMaintOffDutyBanner(); }
  }).then(function(){ return buildData(STATE.self); }).then(function(data){
    var hasNew = false, hasUrgent = false, changed = false;
    Object.keys(data).forEach(function(id){
      var oldMsgs = STATE.data[id] || [];
      var newMsgs = data[id] || [];
      if(oldMsgs.length !== newMsgs.length || messagesChangeSignature(oldMsgs) !== messagesChangeSignature(newMsgs)) changed = true;
      newMsgs.forEach(function(m){
        if(m.from !== "self" && (!prevIds[id] || !prevIds[id][m.id])){
          hasNew = true;
          if(m.urgent) hasUrgent = true;
        }
      });
    });
    if(!changed) return;
    STATE.data = mergePendingIntoData(data);
    renderList();
    if(STATE.active) renderThread();
    if(hasNew && isOnDuty(STATE.self)) playChime(hasUrgent);
  }).finally(function(){ flushOfflineQueue(); loadStories(); });
}

function refreshActiveThread(){
  if(!STATE.active || STATE.loading) return Promise.resolve();
  var id = STATE.active;
  var prevIds = {};
  (STATE.data[id] || []).forEach(function(m){ prevIds[m.id] = true; });
  return apiGet('/api/messages?self=' + encodeURIComponent(STATE.self) + '&with=' + encodeURIComponent(id)).then(function(res){
    var newMsgs = res.messages.map(function(row){ return mapServerMessage(row, STATE.self); });
    var oldMsgs = STATE.data[id] || [];
    if(oldMsgs.length === newMsgs.length && messagesChangeSignature(oldMsgs) === messagesChangeSignature(newMsgs)) return;
    var hasNew = false, hasUrgent = false;
    newMsgs.forEach(function(m){
      if(m.from !== "self" && !prevIds[m.id]){ hasNew = true; if(m.urgent) hasUrgent = true; }
    });
    var patch = {};
    patch[id] = newMsgs;
    mergePendingIntoData(patch);
    STATE.data[id] = patch[id];
    renderList();
    if(STATE.active === id) renderThread();
    if(hasNew && isOnDuty(STATE.self)) playChime(hasUrgent);
  });
}

var slowPollTimer = null;
function startPolling(){
  if(pollTimer) return;
  pollTimer = setInterval(function(){
    if(document.hidden) return;
    refreshActiveThread().catch(function(){});
    refreshMaintenanceBadge();
    pollMissed();
    flushOfflineQueue();
  }, 1500);
  slowPollTimer = setInterval(function(){
    if(document.hidden) return;
    refreshNow().catch(function(){});
    refreshRequestsBadge();
    if(!tabEventsBtn.hidden) refreshEventsBadge();
    if(!tabGuestsBtn.hidden) refreshGuestsBadge();
  }, 6000);
  startTypingPoll();
}
document.addEventListener("visibilitychange", function(){
  if(!document.hidden && AUTH.staff){
    refreshNow().catch(function(){});
  }
});

var typingPollTimer = null;
function startTypingPoll(){
  if(typingPollTimer) return;
  typingPollTimer = setInterval(function(){
    if(document.hidden || STATE.loading || isViewOnly()) return;
    apiGet('/api/typing?self=' + encodeURIComponent(STATE.self)).then(function(res){
      var next = {};
      (res.typing || []).forEach(function(id){ next[id] = true; });
      var changed = JSON.stringify(next) !== JSON.stringify(STATE.typingFrom);
      STATE.typingFrom = next;
      if(changed && STATE.active) renderHeader();
    }).catch(function(){});
  }, 2500);
}

var typingSendTimer = null;
function notifyTyping(){
  if(!STATE.active || isViewOnly()) return;
  if(typingSendTimer) return;
  apiSend('/api/typing', 'POST', { to: STATE.active }).catch(function(){});
  typingSendTimer = setTimeout(function(){ typingSendTimer = null; }, 3000);
}

/* ---------------- Auth ---------------- */
var loginScreen = document.getElementById("loginScreen");
var setupScreen = document.getElementById("setupScreen");
var appRoot = document.getElementById("app");
var loginForm = document.getElementById("loginForm");
var loginName = document.getElementById("loginName");
var loginPin = document.getElementById("loginPin");
var loginBtn = document.getElementById("loginBtn");
var loginError = document.getElementById("loginError");
var setupForm = document.getElementById("setupForm");
var setupName = document.getElementById("setupName");
var setupBtn = document.getElementById("setupBtn");
var setupError = document.getElementById("setupError");
var sbSub = document.getElementById("sbSub");
var switcherWrap = document.getElementById("switcherWrap");
var adminBtn = document.getElementById("adminBtn");
var broadcastBtn = document.getElementById("broadcastBtn");
var logoutBtn = document.getElementById("logoutBtn");

var TOKEN_KEY = "mdash_token";

function enterApp(staff){
  console.log("[PERF] enterApp-start", (performance.now() - __perfT0).toFixed(1) + "ms after script-start");
  AUTH.staff = staff;
  STATE.self = staff.departmentId;
  loginScreen.hidden = true;
  setupScreen.hidden = true;
  appRoot.hidden = false;
  sbSub.textContent = DEPTS[staff.departmentId] ? DEPTS[staff.departmentId].name : "Department heads";
  switcherWrap.hidden = !staff.isAdmin;
  adminBtn.hidden = !staff.isAdmin;
  broadcastBtn.hidden = !staff.isAdmin;
  feedBtn.hidden = !staff.isAdmin;
  responseBtn.hidden = !staff.isAdmin;
  opsOverviewBtn.hidden = !staff.isAdmin;
  tabEventsBtn.hidden = staff.departmentId === "maintenance";
  tabGuestsBtn.hidden = staff.departmentId !== "foh";
  msgInput.placeholder = "Message as " + staff.name + "…";
  boot();
  startPolling();
  setTimeout(function(){
    refreshMaintenanceBadge();
    refreshRequestsBadge();
    if(!tabEventsBtn.hidden) refreshEventsBadge();
    if(staff.departmentId === "concierge") refreshGuestsBadge();
    pollMissed();
    checkPushPrompt();
    loadStories();
  }, 400);
}

function showSetup(staff){
  loginScreen.hidden = true;
  appRoot.hidden = true;
  setupScreen.hidden = false;
  setupName.value = staff.name || "";
  setTimeout(function(){ setupName.focus(); setupName.select(); }, 30);
}

function showLogin(message){
  AUTH.token = null;
  AUTH.staff = null;
  try{ localStorage.removeItem(TOKEN_KEY); }catch(e){}
  appRoot.hidden = true;
  setupScreen.hidden = true;
  loginScreen.hidden = false;
  loginError.textContent = message || "";
  loginPin.value = "";
  setTimeout(function(){ loginName.focus(); }, 30);
}

loginForm.addEventListener("submit", function(e){
  e.preventDefault();
  var name = loginName.value.trim();
  var pin = loginPin.value.trim();
  if(!name || !pin) return;
  loginBtn.disabled = true;
  loginError.textContent = "";
  apiSend('/api/auth/login', 'POST', { name: name, pin: pin }).then(function(res){
    AUTH.token = res.token;
    try{ localStorage.setItem(TOKEN_KEY, res.token); }catch(e){}
    if(!res.staff.profileComplete){
      showSetup(res.staff);
    } else {
      enterApp(res.staff);
    }
  }).catch(function(err){
    loginError.textContent = err.message || "Sign in failed";
    loginPin.value = "";
    loginPin.focus();
  }).finally(function(){ loginBtn.disabled = false; });
});

setupForm.addEventListener("submit", function(e){
  e.preventDefault();
  var name = setupName.value.trim();
  if(!name) return;
  setupBtn.disabled = true;
  setupError.textContent = "";
  apiSend('/api/profile', 'PATCH', { name: name }).then(function(res){
    enterApp(res.staff);
  }).catch(function(err){
    setupError.textContent = err.message || "Couldn't save your profile";
  }).finally(function(){ setupBtn.disabled = false; });
});

logoutBtn.addEventListener("click", function(){
  apiSend('/api/auth/logout', 'POST', {}).catch(function(){}).finally(function(){
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
    if(slowPollTimer){ clearInterval(slowPollTimer); slowPollTimer = null; }
    if(typingPollTimer){ clearInterval(typingPollTimer); typingPollTimer = null; }
    if(groupsPollTimer){ clearInterval(groupsPollTimer); groupsPollTimer = null; }
    showLogin();
  });
});

(function restoreSession(){
  var token;
  try{ token = localStorage.getItem(TOKEN_KEY); }catch(e){ token = null; }
  if(!token){ showLogin(); return; }
  AUTH.token = token;
  apiGet('/api/auth/me').then(function(res){
    if(!res.staff.profileComplete){
      showSetup(res.staff);
    } else {
      enterApp(res.staff);
    }
  }).catch(function(){
    showLogin();
  });
})();

/* ---------------- Admin: manage staff ---------------- */
var adminOverlay = document.getElementById("adminOverlay");
var adminClose = document.getElementById("adminClose");
var staffListEl = document.getElementById("staffList");
var addStaffForm = document.getElementById("addStaffForm");
var addStaffDept = document.getElementById("addStaffDept");
var addStaffError = document.getElementById("addStaffError");

function openAdmin(){
  addStaffDept.innerHTML = "";
  DEPT_ORDER.forEach(function(id){
    var opt = document.createElement("option");
    opt.value = id; opt.textContent = DEPTS[id] ? DEPTS[id].name : id;
    addStaffDept.appendChild(opt);
  });
  adminOverlay.hidden = false;
  loadStaffList();
}

function loadStaffList(){
  staffListEl.innerHTML = '<div style="padding:14px 0;color:var(--text-faint);font-size:12.5px">Loading…</div>';
  apiGet('/api/staff').then(function(res){
    staffListEl.innerHTML = "";
    res.staff.forEach(function(s){ staffListEl.appendChild(buildStaffRow(s)); });
    loadStaffMeta().then(function(){
      renderList();
      renderHeader();
    });
  }).catch(function(){
    staffListEl.innerHTML = '<div style="padding:14px 0;color:var(--urgent);font-size:12.5px">Couldn\'t load staff.</div>';
  });
}

function buildStaffRow(s){
  var row = document.createElement("div");
  row.className = "staff-row";

  var name = document.createElement("div");
  name.className = "staff-row-name";

  var nameText = document.createElement("span");
  nameText.className = "staff-row-name-text";
  nameText.textContent = s.name;
  nameText.title = "Click to rename";
  nameText.addEventListener("click", function(){
    var input = document.createElement("input");
    input.type = "text";
    input.className = "staff-row-name-input";
    input.maxLength = 40;
    input.value = s.name;
    nameText.replaceWith(input);
    input.focus();
    input.select();
    function commit(){
      var val = input.value.trim();
      if(!val || val === s.name){ loadStaffList(); return; }
      apiSend('/api/staff/' + encodeURIComponent(s.id), 'PATCH', { name: val }).then(loadStaffList).catch(loadStaffList);
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); input.blur(); }
      if(e.key === "Escape"){ e.preventDefault(); loadStaffList(); }
    });
  });
  name.appendChild(nameText);

  if(s.isAdmin){
    var adminTag = document.createElement("span");
    adminTag.className = "staff-row-admin";
    adminTag.textContent = "Admin";
    name.appendChild(document.createTextNode(" "));
    name.appendChild(adminTag);
  }

  var sub = document.createElement("span");
  sub.textContent = "Added " + new Date(s.createdAt).toLocaleDateString();
  name.appendChild(sub);

  var select = document.createElement("select");
  DEPT_ORDER.forEach(function(id){
    var opt = document.createElement("option");
    opt.value = id; opt.textContent = DEPTS[id] ? DEPTS[id].name : id;
    if(id === s.departmentId) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", function(){
    apiSend('/api/staff/' + encodeURIComponent(s.id), 'PATCH', { departmentId: select.value }).catch(function(){
      select.value = s.departmentId;
    });
  });

  var resetPin = document.createElement("button");
  resetPin.className = "staff-row-del";
  resetPin.type = "button";
  resetPin.setAttribute("aria-label", "Reset PIN for " + s.name);
  resetPin.title = "Reset PIN";
  resetPin.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
  resetPin.addEventListener("click", function(){
    showPrompt({ title: "Reset PIN for " + s.name, placeholder: "New 4-6 digit PIN", maxLength: 6, confirmLabel: "Reset" }).then(function(newPin){
      if(newPin === null) return;
      if(!/^\d{4,6}$/.test(newPin)){ showToast("PIN must be 4-6 digits"); return; }
      apiSend('/api/staff/' + encodeURIComponent(s.id), 'PATCH', { pin: newPin }).then(function(){
        showToast("PIN reset for " + s.name);
      }).catch(function(){ showToast("Couldn't reset that PIN"); });
    });
  });

  var del = document.createElement("button");
  del.className = "staff-row-del";
  del.type = "button";
  del.setAttribute("aria-label", "Remove " + s.name);
  del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
  del.addEventListener("click", function(){
    if(s.id === AUTH.staff.id) return;
    showConfirm({ title: "Remove " + s.name + "?", confirmLabel: "Remove" }).then(function(ok){
      if(!ok) return;
      apiDelete('/api/staff/' + encodeURIComponent(s.id)).then(loadStaffList).catch(function(){});
    });
  });
  if(s.id === AUTH.staff.id) del.disabled = true;

  row.appendChild(name);
  row.appendChild(select);
  row.appendChild(resetPin);
  row.appendChild(del);
  return row;
}

adminBtn.addEventListener("click", openAdmin);
adminClose.addEventListener("click", function(){ adminOverlay.hidden = true; });
adminOverlay.addEventListener("click", function(e){ if(e.target === adminOverlay) adminOverlay.hidden = true; });

addStaffForm.addEventListener("submit", function(e){
  e.preventDefault();
  var fd = new FormData(addStaffForm);
  var name = String(fd.get("name") || "").trim();
  var pin = String(fd.get("pin") || "").trim();
  var departmentId = fd.get("departmentId");
  addStaffError.textContent = "";
  if(!/^\d{4,6}$/.test(pin)){ addStaffError.textContent = "PIN must be 4-6 digits."; return; }
  apiSend('/api/staff', 'POST', { name: name, pin: pin, departmentId: departmentId }).then(function(){
    addStaffForm.reset();
    loadStaffList();
  }).catch(function(err){
    addStaffError.textContent = err.message || "Couldn't add staff.";
  });
});

/* ---------------- Broadcast ---------------- */
var broadcastOverlay = document.getElementById("broadcastOverlay");
var broadcastClose = document.getElementById("broadcastClose");
var broadcastForm = document.getElementById("broadcastForm");
var broadcastText = document.getElementById("broadcastText");
var broadcastUrgent = document.getElementById("broadcastUrgent");
var broadcastSendBtn = document.getElementById("broadcastSendBtn");
var broadcastError = document.getElementById("broadcastError");

broadcastBtn.addEventListener("click", function(){
  broadcastText.value = "";
  broadcastUrgent.checked = false;
  broadcastError.textContent = "";
  broadcastOverlay.hidden = false;
  setTimeout(function(){ broadcastText.focus(); }, 30);
});
broadcastClose.addEventListener("click", function(){ broadcastOverlay.hidden = true; });
broadcastOverlay.addEventListener("click", function(e){ if(e.target === broadcastOverlay) broadcastOverlay.hidden = true; });

broadcastForm.addEventListener("submit", function(e){
  e.preventDefault();
  var text = broadcastText.value.trim();
  if(!text) return;
  if(containsProfanity(text)){ broadcastError.textContent = "Let's keep it professional. That message can't be sent."; return; }
  showConfirm({
    title: "Send this to every department right now?",
    confirmLabel: "Send",
    neutral: true,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l16-7-7 16-2-7-7-2z"/></svg>'
  }).then(function(ok){
    if(!ok) return;
    broadcastSendBtn.disabled = true;
    broadcastError.textContent = "";
    apiSend('/api/broadcast', 'POST', { text: text, urgent: broadcastUrgent.checked }).then(function(){
      broadcastOverlay.hidden = true;
      return buildData(STATE.self);
    }).then(function(data){
      STATE.data = data;
      renderList();
      if(STATE.active) renderThread();
    }).catch(function(err){
      broadcastError.textContent = err.message || "Couldn't send broadcast.";
    }).finally(function(){ broadcastSendBtn.disabled = false; });
  });
});

var handoverBtn = document.getElementById("handoverBtn");
var handoverOverlay = document.getElementById("handoverOverlay");
var handoverClose = document.getElementById("handoverClose");
var handoverDeptLabel = document.getElementById("handoverDeptLabel");
var handoverForm = document.getElementById("handoverForm");
var handoverText = document.getElementById("handoverText");
var handoverSendBtn = document.getElementById("handoverSendBtn");
var handoverError = document.getElementById("handoverError");
var handoverList = document.getElementById("handoverList");

function fmtNoteTime(ts){
  return new Date(ts).toLocaleString([], {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"});
}

function panelEmptyHtml(icon, title, sub){
  return '<div class="thread-empty-state">' +
    '<div class="thread-empty-icon">'+icon+'</div>' +
    '<div class="thread-empty-title">'+esc(title)+'</div>' +
    (sub ? '<div class="thread-empty-sub">'+esc(sub)+'</div>' : '') +
  '</div>';
}
var PANEL_EMPTY_ICONS = {
  handover: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5a1 1 0 0 0 1 1h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M9 13h6M9 17h4"/></svg>',
  feed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
};
function renderHandoverNotes(notes){
  if(!notes.length){
    handoverList.innerHTML = panelEmptyHtml(PANEL_EMPTY_ICONS.handover, "No handover notes yet", "Add one below so the next shift knows what's going on.");
    return;
  }
  handoverList.innerHTML = "";
  notes.forEach(function(n){
    var row = document.createElement("div");
    row.className = "handover-note";
    var canDelete = n.staffId === AUTH.staff.id || AUTH.staff.isAdmin;
    row.innerHTML =
      '<div class="handover-note-head">'+
        '<span class="handover-note-author">'+esc(n.staffName)+'</span>'+
        '<span class="handover-note-time">'+fmtNoteTime(n.createdAt)+'</span>'+
      '</div>'+
      '<div class="handover-note-body">'+esc(n.body)+'</div>';
    if(canDelete){
      var del = document.createElement("button");
      del.type = "button";
      del.className = "handover-note-del";
      del.setAttribute("aria-label", "Remove note");
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
      del.addEventListener("click", function(){
        showConfirm({ title: "Remove this handover note?", confirmLabel: "Remove" }).then(function(ok){
          if(!ok) return;
          apiDelete('/api/handover/' + encodeURIComponent(n.id)).then(function(){
            notes = notes.filter(function(x){ return x.id !== n.id; });
            renderHandoverNotes(notes);
          }).catch(function(){});
        });
      });
      row.querySelector(".handover-note-head").appendChild(del);
    }
    handoverList.appendChild(row);
  });
}

var currentHandoverNotes = [];
function loadHandoverNotes(){
  return apiGet('/api/handover?department=' + encodeURIComponent(STATE.self)).then(function(res){
    currentHandoverNotes = res.notes;
    renderHandoverNotes(res.notes);
  }).catch(function(){
    handoverList.innerHTML = '<div class="handover-empty">Couldn\'t load handover notes.</div>';
  });
}

var handoverExportBtn = document.getElementById("handoverExportBtn");
handoverExportBtn.addEventListener("click", function(){
  var deptName = DEPTS[STATE.self] ? DEPTS[STATE.self].name : STATE.self;
  var subject = deptName + " shift handover - " + new Date().toLocaleDateString();
  var lines = currentHandoverNotes.length
    ? currentHandoverNotes.map(function(n){ return "- [" + fmtNoteTime(n.createdAt) + "] " + n.staffName + ": " + n.body; })
    : ["No handover notes."];
  var body = subject + "\n\n" + lines.join("\n");
  if(navigator.share){
    navigator.share({ title: subject, text: body }).catch(function(){});
  } else {
    window.location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  }
});

handoverBtn.addEventListener("click", function(){
  handoverDeptLabel.textContent = (DEPTS[STATE.self] ? DEPTS[STATE.self].name : STATE.self) + "'s shift notes. Visible to everyone in this department.";
  handoverText.value = "";
  handoverError.textContent = "";
  handoverForm.hidden = isViewOnly();
  handoverOverlay.hidden = false;
  handoverList.innerHTML = '<div class="handover-empty">Loading…</div>';
  loadHandoverNotes();
  if(!isViewOnly()) setTimeout(function(){ handoverText.focus(); }, 30);
});
handoverClose.addEventListener("click", function(){ handoverOverlay.hidden = true; });
handoverOverlay.addEventListener("click", function(e){ if(e.target === handoverOverlay) handoverOverlay.hidden = true; });

handoverForm.addEventListener("submit", function(e){
  e.preventDefault();
  var text = handoverText.value.trim();
  if(!text) return;
  if(containsProfanity(text)){ handoverError.textContent = "Let's keep it professional. That note can't be posted."; return; }
  handoverSendBtn.disabled = true;
  handoverError.textContent = "";
  apiSend('/api/handover', 'POST', { body: text }).then(function(){
    handoverText.value = "";
    return loadHandoverNotes();
  }).catch(function(err){
    handoverError.textContent = err.message || "Couldn't post that note.";
  }).finally(function(){ handoverSendBtn.disabled = false; });
});

/* ---- Profile: More options dropdown ---- */
var moreOptionsBtn = document.getElementById("moreOptionsBtn");
var moreOptionsSub = document.getElementById("moreOptionsSub");
moreOptionsBtn.addEventListener("click", function(){
  var open = moreOptionsSub.hidden;
  moreOptionsSub.hidden = !open;
  moreOptionsBtn.classList.toggle("open", open);
});

var changePinBtn = document.getElementById("changePinBtn");
var changePinOverlay = document.getElementById("changePinOverlay");
var changePinClose = document.getElementById("changePinClose");
var changePinForm = document.getElementById("changePinForm");
var changePinError = document.getElementById("changePinError");
var changePinSubmitBtn = document.getElementById("changePinSubmitBtn");
changePinBtn.addEventListener("click", function(){
  changePinForm.reset();
  changePinError.textContent = "";
  changePinOverlay.hidden = false;
});
changePinClose.addEventListener("click", function(){ changePinOverlay.hidden = true; });
changePinOverlay.addEventListener("click", function(e){ if(e.target === changePinOverlay) changePinOverlay.hidden = true; });
changePinForm.addEventListener("submit", function(e){
  e.preventDefault();
  var currentPin = changePinForm.currentPin.value.trim();
  var newPin = changePinForm.newPin.value.trim();
  var confirmPin = changePinForm.confirmPin.value.trim();
  changePinError.textContent = "";
  if(!/^\d{4,6}$/.test(newPin)){ changePinError.textContent = "New PIN must be 4 to 6 digits."; return; }
  if(newPin !== confirmPin){ changePinError.textContent = "New PIN and confirmation don't match."; return; }
  changePinSubmitBtn.disabled = true;
  apiSend('/api/profile', 'PATCH', { currentPin: currentPin, pin: newPin }).then(function(){
    changePinOverlay.hidden = true;
    showToast("PIN updated");
  }).catch(function(err){
    changePinError.textContent = err.message || "Couldn't update your PIN.";
  }).finally(function(){ changePinSubmitBtn.disabled = false; });
});

var deptPhotoBtn = document.getElementById("deptPhotoBtn");
var deptPhotoOverlay = document.getElementById("deptPhotoOverlay");
var deptPhotoClose = document.getElementById("deptPhotoClose");
var deptPhotoPreview = document.getElementById("deptPhotoPreview");
var deptPhotoPreviewWrap = document.getElementById("deptPhotoPreviewWrap");
var deptPhotoFileInput = document.getElementById("deptPhotoFileInput");
var deptPhotoRemoveBtn = document.getElementById("deptPhotoRemoveBtn");
var deptPhotoError = document.getElementById("deptPhotoError");
var myProfileBtn = document.getElementById("myProfileBtn");
var myProfileAvatar = document.getElementById("myProfileAvatar");
var myProfileName = document.getElementById("myProfileName");
var myProfileRole = document.getElementById("myProfileRole");
var myProfileStatus = document.getElementById("myProfileStatus");
var myProfileNameForm = document.getElementById("myProfileNameForm");
var myProfileNameInput = document.getElementById("myProfileNameInput");
var myProfileStatusInput = document.getElementById("myProfileStatusInput");
var myProfilePhoneInput = document.getElementById("myProfilePhoneInput");
var myProfileNameSaveBtn = document.getElementById("myProfileNameSaveBtn");
function renderDeptPhotoPreview(){
  var meta = DEPT_META[STATE.self];
  if(meta && meta.photoUrl){
    deptPhotoPreview.style.backgroundImage = "url('"+meta.photoUrl+"')";
    deptPhotoPreview.innerHTML = "";
    deptPhotoRemoveBtn.hidden = false;
  } else {
    deptPhotoPreview.style.backgroundImage = "none";
    deptPhotoPreview.innerHTML = iconSvg(STATE.self);
    deptPhotoRemoveBtn.hidden = true;
  }
}
function renderMyProfileCard(){
  if(!AUTH.staff) return;
  myProfileAvatar.setAttribute("style", avatarStyleAttr(STATE.self));
  myProfileAvatar.innerHTML = avatarInnerHtml(STATE.self);
  myProfileName.textContent = AUTH.staff.name;
  myProfileRole.textContent = DEPTS[STATE.self] ? DEPTS[STATE.self].name : STATE.self;
  myProfileStatus.hidden = !AUTH.staff.statusLine;
  myProfileStatus.textContent = AUTH.staff.statusLine || "";
}
var myProfileNameHint = document.getElementById("myProfileNameHint");
var myProfileNameHintWho = document.getElementById("myProfileNameHintWho");
function openMyProfileOverlay(){
  deptPhotoError.textContent = "";
  myProfileNameInput.value = AUTH.staff ? AUTH.staff.name : "";
  myProfileStatusInput.value = AUTH.staff && AUTH.staff.statusLine ? AUTH.staff.statusLine : "";
  myProfilePhoneInput.value = AUTH.staff && AUTH.staff.phone ? AUTH.staff.phone : "";
  var impersonating = AUTH.staff && STATE.self !== AUTH.staff.departmentId;
  myProfileNameForm.hidden = impersonating;
  myProfileNameHint.hidden = !impersonating;
  if(impersonating) myProfileNameHintWho.textContent = AUTH.staff.name + ", " + (DEPTS[AUTH.staff.departmentId] ? DEPTS[AUTH.staff.departmentId].name : AUTH.staff.departmentId);
  renderDeptPhotoPreview();
  deptPhotoOverlay.hidden = false;
}
myProfileBtn.addEventListener("click", openMyProfileOverlay);
deptPhotoBtn.addEventListener("click", openMyProfileOverlay);
deptPhotoClose.addEventListener("click", function(){ deptPhotoOverlay.hidden = true; });
deptPhotoOverlay.addEventListener("click", function(e){ if(e.target === deptPhotoOverlay) deptPhotoOverlay.hidden = true; });
deptPhotoPreviewWrap.addEventListener("click", function(){ deptPhotoFileInput.click(); });
myProfileNameForm.addEventListener("submit", function(e){
  e.preventDefault();
  var name = myProfileNameInput.value.trim();
  if(!name) return;
  deptPhotoError.textContent = "";
  myProfileNameSaveBtn.disabled = true;
  apiSend('/api/profile', 'PATCH', { name: name, statusLine: myProfileStatusInput.value.trim(), phone: myProfilePhoneInput.value.trim() }).then(function(res){
    AUTH.staff.name = res.staff.name;
    AUTH.staff.statusLine = res.staff.statusLine;
    AUTH.staff.phone = res.staff.phone;
    renderMyProfileCard();
    msgInput.placeholder = "Message as " + AUTH.staff.name + "…";
    return loadStaffMeta();
  }).then(function(){
    renderList();
    renderHeader();
    showToast("Profile updated");
  }).catch(function(err){
    deptPhotoError.textContent = err.message || "Couldn't update your profile.";
  }).finally(function(){ myProfileNameSaveBtn.disabled = false; });
});
/* ---- Photo crop/zoom editor (used for profile photo uploads) ---- */
var photoCropOverlay = document.getElementById("photoCropOverlay");
var photoCropStage = document.getElementById("photoCropStage");
var photoCropImg = document.getElementById("photoCropImg");
var photoCropMask = photoCropOverlay.querySelector(".photo-crop-mask");
var photoCropZoom = document.getElementById("photoCropZoom");
var photoCropCancel = document.getElementById("photoCropCancel");
var photoCropUseBtn = document.getElementById("photoCropUseBtn");
var cropState = null;
var cropResolveCallback = null;
var cropObjectUrl = null;

function openPhotoCropper(file){
  return new Promise(function(resolve){
    cropObjectUrl = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function(){
      photoCropOverlay.hidden = false;
      photoCropImg.src = cropObjectUrl;
      requestAnimationFrame(function(){
        var maskRect = photoCropMask.getBoundingClientRect();
        var size = maskRect.width;
        var baseScale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
        cropState = { img: img, naturalW: img.naturalWidth, naturalH: img.naturalHeight, baseScale: baseScale, zoom: 1, offsetX: 0, offsetY: 0, cropSize: size };
        photoCropZoom.value = 100;
        photoCropImg.style.width = img.naturalWidth + "px";
        photoCropImg.style.height = img.naturalHeight + "px";
        photoCropImg.style.marginLeft = (-img.naturalWidth/2) + "px";
        photoCropImg.style.marginTop = (-img.naturalHeight/2) + "px";
        applyCropTransform();
        cropResolveCallback = resolve;
      });
    };
    img.src = cropObjectUrl;
  });
}
function clampCropOffsets(){
  var scale = cropState.baseScale * cropState.zoom;
  var dispW = cropState.naturalW * scale, dispH = cropState.naturalH * scale;
  var maxX = Math.max(0, (dispW - cropState.cropSize) / 2);
  var maxY = Math.max(0, (dispH - cropState.cropSize) / 2);
  cropState.offsetX = Math.max(-maxX, Math.min(maxX, cropState.offsetX));
  cropState.offsetY = Math.max(-maxY, Math.min(maxY, cropState.offsetY));
}
function applyCropTransform(){
  if(!cropState) return;
  clampCropOffsets();
  var scale = cropState.baseScale * cropState.zoom;
  photoCropImg.style.transform = "translate("+cropState.offsetX+"px,"+cropState.offsetY+"px) scale("+scale+")";
}
function closePhotoCropper(){
  photoCropOverlay.hidden = true;
  if(cropObjectUrl){ URL.revokeObjectURL(cropObjectUrl); cropObjectUrl = null; }
  photoCropImg.src = "";
  cropState = null;
}
var cropPointers = {};
var cropPanStart = null;
var cropPinchStart = null;
function cropPointerArray(){ return Object.keys(cropPointers).map(function(k){ return cropPointers[k]; }); }
function cropDist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y); }
photoCropStage.addEventListener("pointerdown", function(e){
  if(!cropState) return;
  try{ photoCropStage.setPointerCapture(e.pointerId); }catch(err){}
  cropPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
  var pts = cropPointerArray();
  if(pts.length === 1){
    cropPanStart = { x: e.clientX, y: e.clientY, offX: cropState.offsetX, offY: cropState.offsetY };
    cropPinchStart = null;
  } else if(pts.length === 2){
    cropPinchStart = { dist: cropDist(pts[0], pts[1]), zoom: cropState.zoom };
    cropPanStart = null;
  }
});
photoCropStage.addEventListener("pointermove", function(e){
  if(!cropState || !cropPointers[e.pointerId]) return;
  cropPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
  var pts = cropPointerArray();
  if(pts.length === 2 && cropPinchStart){
    var ratio = cropDist(pts[0], pts[1]) / cropPinchStart.dist;
    cropState.zoom = Math.max(1, Math.min(2.5, cropPinchStart.zoom * ratio));
    photoCropZoom.value = Math.round(cropState.zoom * 100);
    applyCropTransform();
  } else if(pts.length === 1 && cropPanStart){
    cropState.offsetX = cropPanStart.offX + (e.clientX - cropPanStart.x);
    cropState.offsetY = cropPanStart.offY + (e.clientY - cropPanStart.y);
    applyCropTransform();
  }
});
function endCropPointer(e){
  delete cropPointers[e.pointerId];
  var pts = cropPointerArray();
  if(pts.length === 1 && cropState){
    cropPanStart = { x: pts[0].x, y: pts[0].y, offX: cropState.offsetX, offY: cropState.offsetY };
    cropPinchStart = null;
  } else if(pts.length === 0){
    cropPanStart = null; cropPinchStart = null;
  }
}
photoCropStage.addEventListener("pointerup", endCropPointer);
photoCropStage.addEventListener("pointercancel", endCropPointer);
photoCropZoom.addEventListener("input", function(){
  if(!cropState) return;
  cropState.zoom = photoCropZoom.value / 100;
  applyCropTransform();
});
photoCropCancel.addEventListener("click", function(){
  var cb = cropResolveCallback;
  closePhotoCropper();
  if(cb) cb(null);
});
photoCropUseBtn.addEventListener("click", function(){
  var scale = cropState.baseScale * cropState.zoom;
  var outputSize = 480;
  var canvas = document.createElement("canvas");
  canvas.width = outputSize; canvas.height = outputSize;
  var ctx = canvas.getContext("2d");
  var srcScale = 1 / scale;
  var srcCropSize = cropState.cropSize * srcScale;
  var srcCenterX = cropState.naturalW/2 - cropState.offsetX * srcScale;
  var srcCenterY = cropState.naturalH/2 - cropState.offsetY * srcScale;
  var sx = srcCenterX - srcCropSize/2;
  var sy = srcCenterY - srcCropSize/2;
  ctx.drawImage(cropState.img, sx, sy, srcCropSize, srcCropSize, 0, 0, outputSize, outputSize);
  canvas.toBlob(function(blob){
    var cb = cropResolveCallback;
    closePhotoCropper();
    if(cb) cb(blob);
  }, "image/jpeg", 0.92);
});

deptPhotoFileInput.addEventListener("change", function(){
  var file = deptPhotoFileInput.files[0];
  deptPhotoFileInput.value = "";
  if(!file) return;
  openPhotoCropper(file).then(function(blob){
    if(!blob) return;
    deptPhotoError.textContent = "";
    deptPhotoPreviewWrap.classList.add("uploading");
    return blobToBase64(blob).then(function(b64){
      return apiSend('/api/departments/' + encodeURIComponent(STATE.self) + '/photo', 'POST', { fileBase64: b64, fileMime: "image/jpeg" });
    }).then(function(res){
      DEPT_META[STATE.self] = res.department;
      renderDeptPhotoPreview();
      renderMyProfileCard();
      renderList();
      renderHeader();
      renderSwitcher();
      showToast("Photo updated");
    }).catch(function(err){
      deptPhotoError.textContent = err.message || "Couldn't upload that photo.";
    }).finally(function(){ deptPhotoPreviewWrap.classList.remove("uploading"); });
  });
});
deptPhotoRemoveBtn.addEventListener("click", function(){
  deptPhotoError.textContent = "";
  deptPhotoRemoveBtn.disabled = true;
  apiDelete('/api/departments/' + encodeURIComponent(STATE.self) + '/photo').then(function(res){
    DEPT_META[STATE.self] = res.department;
    renderDeptPhotoPreview();
    renderMyProfileCard();
    renderList();
    renderHeader();
    renderSwitcher();
    showToast("Photo removed");
  }).catch(function(err){
    deptPhotoError.textContent = err.message || "Couldn't remove that photo.";
  }).finally(function(){ deptPhotoRemoveBtn.disabled = false; });
});

/* ---- Stories ---- */
var storiesRow = document.getElementById("storiesRow");
STATE.stories = [];
function fmtStoryAge(iso){
  var diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/60000));
  if(diff < 1) return "Just now";
  if(diff < 60) return diff + (diff === 1 ? " min ago" : " mins ago");
  var h = Math.round(diff/60);
  return h + (h === 1 ? " hour ago" : " hours ago");
}
function storiesByDept(){
  var grouped = {};
  STATE.stories.forEach(function(s){
    grouped[s.departmentId] = grouped[s.departmentId] || [];
    grouped[s.departmentId].push(s);
  });
  Object.keys(grouped).forEach(function(id){ grouped[id].sort(function(a,b){ return new Date(a.createdAt) - new Date(b.createdAt); }); });
  return grouped;
}
function loadStories(){
  return apiGet('/api/stories').then(function(res){
    STATE.stories = res.stories || [];
    renderStoriesRow();
  }).catch(function(){});
}
function renderStoriesRow(){
  var grouped = storiesByDept();
  var mine = grouped[STATE.self] || [];
  var others = DEPT_ORDER.filter(function(id){ return id !== STATE.self && grouped[id] && grouped[id].length; });
  others.sort(function(a,b){
    var aUnseen = grouped[a].some(function(s){ return !s.viewed; });
    var bUnseen = grouped[b].some(function(s){ return !s.viewed; });
    if(aUnseen !== bUnseen) return aUnseen ? -1 : 1;
    var aLast = grouped[a][grouped[a].length-1].createdAt;
    var bLast = grouped[b][grouped[b].length-1].createdAt;
    return new Date(bLast) - new Date(aLast);
  });
  var order = [STATE.self].concat(others);
  storiesRow.innerHTML = "";
  order.forEach(function(id){
    var reel = grouped[id] || [];
    var isMine = id === STATE.self;
    var hasUnseen = reel.some(function(s){ return !s.viewed; });
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "story-item" + (isMine ? " mine" : "") + (hasUnseen ? " unseen" : "");
    var d = DEPTS[id];
    btn.innerHTML =
      '<span class="story-ring"><span class="story-avatar-inner" style="'+avatarStyleAttr(id)+'">'+avatarInnerHtml(id)+'</span>'+
        (isMine ? '<span class="story-add-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>' : '') +
      '</span>' +
      '<span class="story-item-label">'+(isMine ? "Your story" : esc(d ? d.name : id))+'</span>';
    btn.addEventListener("click", function(e){
      if(isMine && e.target.closest(".story-add-badge")){ openPostStoryOverlay(); return; }
      if(reel.length) openStoryViewer(id);
      else if(isMine) openPostStoryOverlay();
    });
    storiesRow.appendChild(btn);
  });
}

var storyEditor = document.getElementById("storyEditor");
var storyEditorImg = document.getElementById("storyEditorImg");
var postStoryClose = document.getElementById("postStoryClose");
var storyRetakeBtn = document.getElementById("storyRetakeBtn");
var storyPhotoInput = document.getElementById("storyPhotoInput");
var storyCaptionInput = document.getElementById("storyCaptionInput");
var storyPostBtn = document.getElementById("storyPostBtn");
var storyPostError = document.getElementById("storyPostError");
var storyPendingFile = null;
function openPostStoryOverlay(){
  storyPhotoInput.click();
}
function autoGrowStoryCaption(){
  storyCaptionInput.style.height = "auto";
  storyCaptionInput.style.height = Math.min(storyCaptionInput.scrollHeight, 160) + "px";
}
storyPhotoInput.addEventListener("change", function(){
  var file = storyPhotoInput.files[0];
  storyPhotoInput.value = "";
  if(!file) return;
  var isFreshOpen = storyEditor.hidden;
  storyPendingFile = file;
  var reader = new FileReader();
  reader.onload = function(){
    storyEditorImg.src = reader.result;
    if(isFreshOpen) storyCaptionInput.value = "";
    storyPostError.textContent = "";
    storyEditor.hidden = false;
    autoGrowStoryCaption();
  };
  reader.readAsDataURL(file);
});
postStoryClose.addEventListener("click", function(){ storyEditor.hidden = true; storyPendingFile = null; });
storyRetakeBtn.addEventListener("click", function(){ storyPhotoInput.click(); });
storyCaptionInput.addEventListener("input", autoGrowStoryCaption);
function postStoryNow(){
  if(!storyPendingFile || storyPostBtn.disabled) return;
  storyPostError.textContent = "";
  storyPostBtn.disabled = true;
  blobToBase64(storyPendingFile).then(function(b64){
    return apiSend('/api/stories', 'POST', { fileBase64: b64, fileMime: storyPendingFile.type, caption: storyCaptionInput.value.trim() || undefined });
  }).then(function(res){
    STATE.stories.push(res.story);
    renderStoriesRow();
    storyEditor.hidden = true;
    storyPendingFile = null;
    showToast("Update posted");
  }).catch(function(err){
    storyPostError.textContent = err.message || "Couldn't post that update.";
    storyPostBtn.disabled = false;
  });
}
storyPostBtn.addEventListener("click", postStoryNow);
storyEditorImg.addEventListener("click", postStoryNow);

var storyViewer = document.getElementById("storyViewer");
var storyProgressRow = document.getElementById("storyProgressRow");
var storyViewerAvatar = document.getElementById("storyViewerAvatar");
var storyViewerName = document.getElementById("storyViewerName");
var storyViewerSub = document.getElementById("storyViewerSub");
var storyViewerImg = document.getElementById("storyViewerImg");
var storyViewerCaption = document.getElementById("storyViewerCaption");
var storyViewerClose = document.getElementById("storyViewerClose");
var storyViewerDelete = document.getElementById("storyViewerDelete");
var storyTapLeft = document.getElementById("storyTapLeft");
var storyTapRight = document.getElementById("storyTapRight");
var storyViewerStage = document.getElementById("storyViewerStage");
var STORY_DURATION_MS = 5000;
var storyViewState = null;
var storyHoldTimer = null;
var storySuppressClick = false;

function storyReelOrder(){
  var grouped = storiesByDept();
  var order = [STATE.self].concat(DEPT_ORDER.filter(function(id){ return id !== STATE.self; }));
  return order.filter(function(id){ return grouped[id] && grouped[id].length; });
}
function openStoryViewer(deptId){
  var grouped = storiesByDept();
  var deptOrder = storyReelOrder();
  var idx = deptOrder.indexOf(deptId);
  if(idx === -1) return;
  storyViewState = { deptOrder: deptOrder, deptIdx: idx, storyIdx: 0, timer: null };
  storyViewer.hidden = false;
  renderStoryFrame();
}
function currentReel(){
  if(!storyViewState) return [];
  var grouped = storiesByDept();
  return grouped[storyViewState.deptOrder[storyViewState.deptIdx]] || [];
}
function renderStoryFrame(){
  if(!storyViewState) return;
  if(storyViewState.timer){ clearTimeout(storyViewState.timer); storyViewState.timer = null; }
  var reel = currentReel();
  if(!reel.length){ closeStoryViewer(); return; }
  var deptId = storyViewState.deptOrder[storyViewState.deptIdx];
  var story = reel[storyViewState.storyIdx];

  storyProgressRow.innerHTML = "";
  reel.forEach(function(s, i){
    var seg = document.createElement("div");
    seg.className = "story-progress-seg" + (i < storyViewState.storyIdx ? " done" : (i === storyViewState.storyIdx ? " active" : ""));
    seg.innerHTML = '<div class="story-progress-fill"></div>';
    if(i === storyViewState.storyIdx){
      seg.querySelector(".story-progress-fill").style.animationDuration = STORY_DURATION_MS + "ms";
    }
    storyProgressRow.appendChild(seg);
  });

  storyViewerAvatar.setAttribute("style", avatarStyleAttr(deptId));
  storyViewerAvatar.innerHTML = avatarInnerHtml(deptId);
  storyViewerName.textContent = (story.staffName ? story.staffName : (DEPTS[deptId] ? DEPTS[deptId].name : deptId));
  storyViewerSub.textContent = (DEPTS[deptId] ? DEPTS[deptId].name : "") + " · " + fmtStoryAge(story.createdAt);
  storyViewerImg.src = story.photoUrl;
  storyViewerCaption.textContent = story.caption || "";
  storyViewerCaption.hidden = !story.caption;
  storyViewerDelete.hidden = !(deptId === STATE.self || (AUTH.staff && AUTH.staff.isAdmin));

  if(!story.viewed){
    story.viewed = true;
    apiSend('/api/stories/' + encodeURIComponent(story.id) + '/view', 'POST', {}).catch(function(){});
  }

  storyViewState.paused = false;
  storyViewState.remainingMs = STORY_DURATION_MS;
  storyViewState.segStartedAt = Date.now();
  storyViewState.timer = setTimeout(function(){ storyAdvance(1); }, STORY_DURATION_MS);
}
function pauseStoryProgress(){
  if(!storyViewState || storyViewState.paused) return;
  storyViewState.paused = true;
  if(storyViewState.timer){ clearTimeout(storyViewState.timer); storyViewState.timer = null; }
  storyViewState.remainingMs = Math.max(storyViewState.remainingMs - (Date.now() - storyViewState.segStartedAt), 0);
  var activeFill = storyProgressRow.querySelector(".story-progress-seg.active .story-progress-fill");
  if(activeFill) activeFill.style.animationPlayState = "paused";
}
function resumeStoryProgress(){
  if(!storyViewState || !storyViewState.paused) return;
  storyViewState.paused = false;
  storyViewState.segStartedAt = Date.now();
  var activeFill = storyProgressRow.querySelector(".story-progress-seg.active .story-progress-fill");
  if(activeFill) activeFill.style.animationPlayState = "running";
  storyViewState.timer = setTimeout(function(){ storyAdvance(1); }, storyViewState.remainingMs);
}
function storyAdvance(dir){
  if(!storyViewState) return;
  var reel = currentReel();
  var nextStoryIdx = storyViewState.storyIdx + dir;
  if(nextStoryIdx >= 0 && nextStoryIdx < reel.length){
    storyViewState.storyIdx = nextStoryIdx;
    renderStoryFrame();
    return;
  }
  var nextDeptIdx = storyViewState.deptIdx + dir;
  if(nextDeptIdx >= 0 && nextDeptIdx < storyViewState.deptOrder.length){
    storyViewState.deptIdx = nextDeptIdx;
    storyViewState.storyIdx = dir > 0 ? 0 : (storiesByDept()[storyViewState.deptOrder[nextDeptIdx]] || []).length - 1;
    renderStoryFrame();
    return;
  }
  closeStoryViewer();
}
function closeStoryViewer(){
  if(storyViewState && storyViewState.timer) clearTimeout(storyViewState.timer);
  storyViewState = null;
  storyViewer.hidden = true;
  renderStoriesRow();
}
storyViewerClose.addEventListener("click", closeStoryViewer);
storyTapLeft.addEventListener("click", function(){ if(storySuppressClick){ storySuppressClick = false; return; } storyAdvance(-1); });
storyTapRight.addEventListener("click", function(){ if(storySuppressClick){ storySuppressClick = false; return; } storyAdvance(1); });
storyViewerStage.addEventListener("pointerdown", function(){
  clearTimeout(storyHoldTimer);
  storyHoldTimer = setTimeout(function(){
    pauseStoryProgress();
    storySuppressClick = true;
  }, 180);
});
function endStoryHold(){
  clearTimeout(storyHoldTimer);
  if(storyViewState && storyViewState.paused) resumeStoryProgress();
}
storyViewerStage.addEventListener("pointerup", endStoryHold);
storyViewerStage.addEventListener("pointercancel", endStoryHold);
storyViewerStage.addEventListener("pointerleave", endStoryHold);
storyViewerDelete.addEventListener("click", function(){
  if(!storyViewState) return;
  var reel = currentReel();
  var story = reel[storyViewState.storyIdx];
  if(!story) return;
  showConfirm({ title: "Delete this update?" }).then(function(ok){
    if(!ok) return;
    apiDelete('/api/stories/' + encodeURIComponent(story.id)).then(function(){
      STATE.stories = STATE.stories.filter(function(s){ return s.id !== story.id; });
      var newReel = currentReel();
      if(!newReel.length){ storyAdvance(1); return; }
      if(storyViewState.storyIdx >= newReel.length) storyViewState.storyIdx = newReel.length - 1;
      renderStoryFrame();
    }).catch(function(){ showToast("Couldn't delete that update"); });
  });
});

var notifSettingsBtn = document.getElementById("notifSettingsBtn");
var notifSettingsOverlay = document.getElementById("notifSettingsOverlay");
var notifSettingsClose = document.getElementById("notifSettingsClose");
var notifSettingsList = document.getElementById("notifSettingsList");
function renderNotifSettings(mutedIds){
  if(!mutedIds.length){
    notifSettingsList.innerHTML = '<div class="handover-empty">You haven\'t muted any conversations.</div>';
    return;
  }
  notifSettingsList.innerHTML = "";
  mutedIds.forEach(function(deptId){
    var row = document.createElement("div");
    row.className = "mute-row";
    var name = document.createElement("span");
    name.className = "mute-row-name";
    name.textContent = DEPTS[deptId] ? DEPTS[deptId].name : deptId;
    row.appendChild(name);
    var unmuteBtn = document.createElement("button");
    unmuteBtn.type = "button";
    unmuteBtn.textContent = "Unmute";
    unmuteBtn.addEventListener("click", function(){
      apiSend('/api/muted', 'POST', { with: deptId }).then(function(res){
        STATE.muted[deptId] = res.muted;
        if(STATE.active === deptId){ muteBtn.classList.toggle("active", res.muted); }
        showToast("Unmuted");
        loadNotifSettings();
      }).catch(function(){ showToast("Couldn't unmute"); });
    });
    row.appendChild(unmuteBtn);
    notifSettingsList.appendChild(row);
  });
}
function loadNotifSettings(){
  notifSettingsList.innerHTML = '<div class="handover-empty">Loading…</div>';
  apiGet('/api/muted?self=' + encodeURIComponent(STATE.self)).then(function(res){
    renderNotifSettings(res.muted || []);
  }).catch(function(){
    notifSettingsList.innerHTML = '<div class="handover-empty">Couldn\'t load notification settings.</div>';
  });
}
notifSettingsBtn.addEventListener("click", function(){
  notifSettingsOverlay.hidden = false;
  loadNotifSettings();
});
notifSettingsClose.addEventListener("click", function(){ notifSettingsOverlay.hidden = true; });
notifSettingsOverlay.addEventListener("click", function(e){ if(e.target === notifSettingsOverlay) notifSettingsOverlay.hidden = true; });

var pushEnableRowBtn = document.getElementById("pushEnableRowBtn");
pushEnableRowBtn.addEventListener("click", function(){
  if(!pushSupported()){ showToast("Push isn't supported on this device"); return; }
  if(Notification.permission === "denied"){
    showToast("Notifications are blocked. Enable them in your device Settings.");
    return;
  }
  pushEnableRowBtn.disabled = true;
  Notification.requestPermission().then(function(perm){
    if(perm !== "granted"){ showToast("Notifications weren't enabled"); return; }
    return subscribeToPush().then(function(){ showToast("Notifications enabled"); });
  }).catch(function(){
    showToast("Couldn't enable notifications");
  }).finally(function(){ pushEnableRowBtn.disabled = false; });
});

var myActivityBtn = document.getElementById("myActivityBtn");
var myActivityOverlay = document.getElementById("myActivityOverlay");
var myActivityClose = document.getElementById("myActivityClose");
var myActivityList = document.getElementById("myActivityList");
myActivityBtn.addEventListener("click", function(){
  myActivityList.innerHTML = '<div class="handover-empty">Loading…</div>';
  myActivityOverlay.hidden = false;
  apiGet('/api/response-times?mine=1').then(function(res){
    renderResponseTimes(res.departments, myActivityList);
  }).catch(function(){
    myActivityList.innerHTML = '<div class="handover-empty">Couldn\'t load your activity.</div>';
  });
});
myActivityClose.addEventListener("click", function(){ myActivityOverlay.hidden = true; });
myActivityOverlay.addEventListener("click", function(e){ if(e.target === myActivityOverlay) myActivityOverlay.hidden = true; });

var missedApprovalsBox = document.getElementById("missedApprovalsBox");
var missedApprovalsList = document.getElementById("missedApprovalsList");
var missedApprovalsCount = document.getElementById("missedApprovalsCount");
var missedMsgBox = document.getElementById("missedMsgBox");
var missedMsgList = document.getElementById("missedMsgList");
var missedMsgCount = document.getElementById("missedMsgCount");
var missedTicketsBox = document.getElementById("missedTicketsBox");
var missedTicketList = document.getElementById("missedTicketList");
var missedTicketCount = document.getElementById("missedTicketCount");
var missedGuestsBox = document.getElementById("missedGuestsBox");
var missedGuestList = document.getElementById("missedGuestList");
var missedGuestCount = document.getElementById("missedGuestCount");
var missedPlannerBox = document.getElementById("missedPlannerBox");
var missedPlannerList = document.getElementById("missedPlannerList");
var missedPlannerCount = document.getElementById("missedPlannerCount");

function buildMissedMessageCard(item){
  var m = item.message;
  var dept = DEPTS[m.from] || { name: m.from, initials: "?", color: "#888" };
  var preview = m.type === "text" ? m.body : (m.type === "image" ? "📷 Photo" : m.type === "file" ? "📎 " + (m.fileName || "File") : "🎤 Voice message");
  var card = document.createElement("div");
  card.className = "missed-msg-card";
  card.innerHTML =
    '<span class="missed-msg-avatar" style="' + avatarStyleAttr(m.from) + '">' + avatarInnerHtml(m.from) + '</span>' +
    '<div class="missed-msg-body">' +
      '<div class="missed-msg-top"><span class="missed-msg-from">' + esc(dept.name) + '</span>' + (m.urgent ? '<span class="missed-msg-urgent">Urgent</span>' : '') + '</div>' +
      '<div class="missed-msg-preview">' + esc(preview) + '</div>' +
      '<div class="missed-msg-time">' + fmtNoteTime(item.createdAt) + '</div>' +
    '</div>';
  card.addEventListener("click", function(){
    showTab("chat");
    openThread(m.from);
  });
  return card;
}

function buildMissedApprovalCard(item){
  var m = item.message;
  var s = m.signoff;
  var dept = DEPTS[m.from] || { name: m.from, initials: "?", color: "#888" };
  var card = document.createElement("div");
  card.className = "missed-msg-card missed-approval-card";
  card.innerHTML =
    '<span class="missed-msg-avatar" style="' + avatarStyleAttr(m.from) + '">' + avatarInnerHtml(m.from) + '</span>' +
    '<div class="missed-msg-body">' +
      (s.amount != null ? '<div class="request-amount-hero">' + esc(fmtSignoffAmount(s.amount)) + '</div>' : '') +
      '<div class="missed-msg-top">' +
        (s.code ? '<span class="request-code-badge">' + esc(s.code) + '</span>' : '') +
        '<span class="missed-msg-from">' + esc(dept.name) + '</span>' +
      '</div>' +
      '<div class="missed-msg-preview">' + esc(s.title) + '</div>' +
      '<div class="missed-approval-actions">' +
        '<button type="button" class="missed-approval-decline">Decline</button>' +
        '<button type="button" class="missed-approval-approve">Approve</button>' +
      '</div>' +
    '</div>';
  card.querySelector(".missed-msg-body").addEventListener("click", function(e){
    if(e.target.closest(".missed-approval-actions")) return;
    showTab("chat");
    openThread(m.from);
  });
  function decide(decision, btn){
    btn.disabled = true;
    apiSend('/api/messages/' + encodeURIComponent(m.id) + '/signoff-decision', 'POST', { decision: decision }).then(function(res){
      var msgs = STATE.data[m.from];
      if(msgs){
        var idx = msgs.findIndex(function(x){ return x.id === m.id; });
        if(idx !== -1) msgs[idx] = mapServerMessage(res.message, STATE.self);
      }
      if(STATE.active === m.from) renderThread();
      showToast(decision === "approved" ? "Approved" : "Declined");
      pollMissed();
    }).catch(function(){
      showToast("Couldn't record that decision");
      btn.disabled = false;
    });
  }
  card.querySelector(".missed-approval-approve").addEventListener("click", function(e){ e.stopPropagation(); decide("approved", e.target); });
  card.querySelector(".missed-approval-decline").addEventListener("click", function(e){ e.stopPropagation(); decide("declined", e.target); });
  return card;
}

function buildMissedPlannerCard(item){
  var p = item.planner;
  var card = document.createElement("div");
  card.className = "missed-msg-card missed-planner-card";
  card.innerHTML =
    '<div class="missed-msg-body">' +
      '<div class="missed-msg-preview">' + esc(p.title) + (p.startsAt ? ' — ' + esc(p.startsAt) : '') + '</div>' +
      (p.details ? '<div class="missed-msg-time">' + esc(p.details) + '</div>' : '') +
    '</div>';
  card.addEventListener("click", function(){
    card.classList.add("dismissing");
    apiSend('/api/planner-notifications/' + encodeURIComponent(p.id) + '/read', 'POST', {}).then(function(){
      pollMissed();
    }).catch(function(){
      card.classList.remove("dismissing");
      showToast("Couldn't dismiss that");
    });
  });
  return card;
}

function renderMissedFeed(items){
  var approvals = items.filter(function(i){ return i.kind === "approval"; });
  missedApprovalsBox.hidden = approvals.length === 0;
  missedApprovalsCount.textContent = String(approvals.length);
  missedApprovalsList.innerHTML = "";
  approvals.forEach(function(item){ missedApprovalsList.appendChild(buildMissedApprovalCard(item)); });

  var messages = items.filter(function(i){ return i.kind === "message"; });
  var tickets = items.filter(function(i){ return i.kind === "ticket"; });
  var guests = items.filter(function(i){ return i.kind === "guestRequest"; });

  missedMsgBox.hidden = messages.length === 0;
  missedMsgCount.textContent = String(messages.length);
  missedMsgList.innerHTML = "";
  messages.forEach(function(item){ missedMsgList.appendChild(buildMissedMessageCard(item)); });

  var showTickets = STATE.self === "maintenance" && tickets.length > 0;
  missedTicketsBox.hidden = !showTickets;
  if(showTickets){
    missedTicketCount.textContent = String(tickets.length);
    missedTicketList.innerHTML = "";
    tickets.forEach(function(item){
      STATE.tickets = STATE.tickets || [];
      if(!STATE.tickets.some(function(x){ return x.id === item.ticket.id; })) STATE.tickets.push(item.ticket);
      missedTicketList.appendChild(buildMaintCard(item.ticket));
    });
  }

  var showGuests = STATE.self === "foh" && guests.length > 0;
  missedGuestsBox.hidden = !showGuests;
  if(showGuests){
    missedGuestCount.textContent = String(guests.length);
    missedGuestList.innerHTML = "";
    guests.forEach(function(item){
      STATE.guestRequests = STATE.guestRequests || [];
      if(!STATE.guestRequests.some(function(x){ return x.id === item.request.id; })) STATE.guestRequests.push(item.request);
      missedGuestList.appendChild(buildGuestCard(item.request));
    });
  }

  var planners = items.filter(function(i){ return i.kind === "planner"; });
  missedPlannerBox.hidden = planners.length === 0;
  missedPlannerCount.textContent = String(planners.length);
  missedPlannerList.innerHTML = "";
  planners.forEach(function(item){ missedPlannerList.appendChild(buildMissedPlannerCard(item)); });
}

function pollMissed(){
  apiGet('/api/missed').then(function(res){
    if(!profilePage.hidden) renderMissedFeed(res.items);
  }).catch(function(){});
}

var privacyBtn = document.getElementById("privacyBtn");
var privacyOverlay = document.getElementById("privacyOverlay");
var privacyClose = document.getElementById("privacyClose");
privacyBtn.addEventListener("click", function(){ privacyOverlay.hidden = false; });
privacyClose.addEventListener("click", function(){ privacyOverlay.hidden = true; });
privacyOverlay.addEventListener("click", function(e){ if(e.target === privacyOverlay) privacyOverlay.hidden = true; });

var helpSupportBtn = document.getElementById("helpSupportBtn");
var helpSupportOverlay = document.getElementById("helpSupportOverlay");
var helpSupportClose = document.getElementById("helpSupportClose");
helpSupportBtn.addEventListener("click", function(){ helpSupportOverlay.hidden = false; });
helpSupportClose.addEventListener("click", function(){ helpSupportOverlay.hidden = true; });
helpSupportOverlay.addEventListener("click", function(e){ if(e.target === helpSupportOverlay) helpSupportOverlay.hidden = true; });

var profilePage = document.getElementById("profilePage");
var chatPage = document.getElementById("chatPage");
var eventsPage = document.getElementById("eventsPage");
var maintenancePage = document.getElementById("maintenancePage");
var guestsPage = document.getElementById("guestsPage");
var requestsPage = document.getElementById("requestsPage");
var tabProfileBtn = document.getElementById("tabProfileBtn");
var tabChatBtn = document.getElementById("tabChatBtn");
var tabEventsBtn = document.getElementById("tabEventsBtn");
var tabMaintBtn = document.getElementById("tabMaintBtn");
var tabGuestsBtn = document.getElementById("tabGuestsBtn");
var tabRequestsBtn = document.getElementById("tabRequestsBtn");
function showTab(tab){
  profilePage.hidden = tab !== "profile";
  chatPage.hidden = tab !== "chat";
  eventsPage.hidden = tab !== "events";
  maintenancePage.hidden = tab !== "maintenance";
  guestsPage.hidden = tab !== "guests";
  requestsPage.hidden = tab !== "requests";
  tabProfileBtn.classList.toggle("active", tab === "profile");
  tabChatBtn.classList.toggle("active", tab === "chat");
  tabEventsBtn.classList.toggle("active", tab === "events");
  tabMaintBtn.classList.toggle("active", tab === "maintenance");
  tabGuestsBtn.classList.toggle("active", tab === "guests");
  tabRequestsBtn.classList.toggle("active", tab === "requests");
  if(tab === "events") openEventsTab();
  if(tab === "maintenance") openMaintenanceTab();
  if(tab === "guests") openGuestsTab();
  if(tab === "requests") openRequestsTab();
  if(tab === "profile") pollMissed();
}
tabProfileBtn.addEventListener("click", function(){ showTab("profile"); });
tabChatBtn.addEventListener("click", function(){ showTab("chat"); });
tabEventsBtn.addEventListener("click", function(){ showTab("events"); });
tabMaintBtn.addEventListener("click", function(){ showTab("maintenance"); });
tabGuestsBtn.addEventListener("click", function(){ showTab("guests"); });
tabRequestsBtn.addEventListener("click", function(){ showTab("requests"); });
showTab("chat");

(function setupTabBarDrag(){
  var bar = document.querySelector(".bottom-tabs");
  var activePointerId = null;
  var hoverEl = null;
  var startEl = null;
  function tabAt(x, y){
    var el = document.elementFromPoint(x, y);
    return el ? el.closest(".bottom-tab") : null;
  }
  function setHover(el){
    if(hoverEl === el) return;
    if(hoverEl) hoverEl.classList.remove("drag-hover");
    hoverEl = el;
    if(hoverEl) hoverEl.classList.add("drag-hover");
  }
  function endDrag(e){
    if(e.pointerId !== activePointerId) return;
    activePointerId = null;
    var el = hoverEl;
    setHover(null);
    if(el && el !== startEl){ if(navigator.vibrate) navigator.vibrate(8); el.click(); }
    startEl = null;
  }
  bar.addEventListener("pointerdown", function(e){
    if(e.button !== undefined && e.button !== 0) return;
    activePointerId = e.pointerId;
    startEl = tabAt(e.clientX, e.clientY);
  });
  bar.addEventListener("pointermove", function(e){
    if(e.pointerId !== activePointerId) return;
    setHover(tabAt(e.clientX, e.clientY));
  });
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", function(e){
    if(e.pointerId !== activePointerId) return;
    activePointerId = null;
    setHover(null);
    startEl = null;
  });
})();

var filesBtn = document.getElementById("filesBtn");
var filesOverlay = document.getElementById("filesOverlay");
var filesClose = document.getElementById("filesClose");
var filesGrid = document.getElementById("filesGrid");

function jumpToMessage(id){
  filesOverlay.hidden = true;
  var target = threadScroll.querySelector('[data-msg-id="'+id+'"]');
  if(target){
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("flash-highlight");
    setTimeout(function(){ target.classList.remove("flash-highlight"); }, 1200);
  }
}

var FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5a1 1 0 0 0 1 1h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/></svg>';
var AUDIO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

filesBtn.addEventListener("click", function(){
  var msgs = (STATE.data[STATE.active] || []).filter(function(m){ return !m.deleted && (m.type === "image" || m.type === "file" || m.type === "audio"); });
  msgs = msgs.slice().reverse();
  if(!msgs.length){
    filesGrid.innerHTML = '<div class="handover-empty" style="grid-column:1/-1">No shared files in this conversation.</div>';
  } else {
    filesGrid.innerHTML = "";
    msgs.forEach(function(m){
      var el = document.createElement("button");
      el.type = "button";
      if(m.type === "image"){
        el.className = "files-thumb";
        el.innerHTML = '<img src="'+(m.dataUrl || m.url)+'" alt="Shared photo">';
        el.addEventListener("click", function(){ window.open(m.url || m.dataUrl, "_blank"); });
      } else if(m.type === "file"){
        el.className = "files-thumb doc";
        el.innerHTML = FILE_ICON + '<span class="files-thumb-label">'+esc(m.fileName || "File")+'</span>';
        el.addEventListener("click", function(){ if(m.url) window.open(m.url, "_blank"); });
      } else {
        el.className = "files-thumb audio";
        el.innerHTML = AUDIO_ICON + '<span class="files-thumb-label">Voice note</span>';
        el.addEventListener("click", function(){ jumpToMessage(m.id); });
      }
      filesGrid.appendChild(el);
    });
  }
  filesOverlay.hidden = false;
});
filesClose.addEventListener("click", function(){ filesOverlay.hidden = true; });
filesOverlay.addEventListener("click", function(e){ if(e.target === filesOverlay) filesOverlay.hidden = true; });

var feedBtn = document.getElementById("feedBtn");
var feedOverlay = document.getElementById("feedOverlay");
var feedClose = document.getElementById("feedClose");
var feedList = document.getElementById("feedList");

function openFeedItem(m){
  feedOverlay.hidden = true;
  var targetSelf = m.from, targetOther = m.to;
  if(STATE.self === targetSelf){
    openThread(targetOther);
    return;
  }
  STATE.self = targetSelf;
  STATE.loading = true;
  renderSwitcher();
  updateComposerLock();
  buildData(targetSelf).then(function(data){
    STATE.data = mergePendingIntoData(data);
    renderList();
    renderDuty();
    openThread(targetOther);
  }).finally(function(){ STATE.loading = false; });
}

function renderFeed(messages){
  if(!messages.length){
    feedList.innerHTML = panelEmptyHtml(PANEL_EMPTY_ICONS.feed, "Nothing here yet", "Every conversation across the hotel will show up here, most recent first.");
    return;
  }
  feedList.innerHTML = "";
  messages.forEach(function(m){
    var row = document.createElement("button");
    row.type = "button";
    row.className = "feed-row";
    var preview = messagePreviewLabel(m);
    row.innerHTML =
      '<span class="feed-avatar" style="'+avatarStyleAttr(m.from)+'">'+avatarInnerHtml(m.from)+'</span>'+
      '<span class="feed-body">'+
        '<span class="feed-route">'+esc(DEPTS[m.from] ? DEPTS[m.from].name : m.from)+
          '<span class="arrow">→</span>'+esc(DEPTS[m.to] ? DEPTS[m.to].name : m.to)+'</span>'+
        '<span class="feed-text'+(m.deleted?' deleted':'')+'">'+esc(preview)+'</span>'+
      '</span>'+
      '<span class="feed-time">'+fmtRelative(m.t)+'</span>';
    row.addEventListener("click", function(){ openFeedItem(m); });
    feedList.appendChild(row);
  });
}

feedBtn.addEventListener("click", function(){
  feedList.innerHTML = '<div class="handover-empty">Loading…</div>';
  feedOverlay.hidden = false;
  apiGet('/api/feed?limit=60').then(function(res){
    renderFeed(res.messages.map(function(row){ return mapServerMessage(row, "__feed__"); }));
  }).catch(function(){
    feedList.innerHTML = '<div class="handover-empty">Couldn\'t load the feed.</div>';
  });
});
feedClose.addEventListener("click", function(){ feedOverlay.hidden = true; });
feedOverlay.addEventListener("click", function(e){ if(e.target === feedOverlay) feedOverlay.hidden = true; });

var RESPONSE_SLOW_SECONDS = 10 * 60;
var responseBtn = document.getElementById("responseBtn");
var responseOverlay = document.getElementById("responseOverlay");
var responseClose = document.getElementById("responseClose");
var responseList = document.getElementById("responseList");

function fmtDuration(seconds){
  seconds = Math.round(seconds);
  if(seconds < 60) return seconds + "s";
  var mins = Math.round(seconds / 60);
  if(mins < 60) return mins + "m";
  var hrs = Math.floor(mins / 60);
  return hrs + "h " + (mins % 60) + "m";
}

function renderResponseTimes(departments, targetEl){
  targetEl = targetEl || responseList;
  if(!departments.length){
    targetEl.innerHTML = panelEmptyHtml(PANEL_EMPTY_ICONS.clock, "No urgent messages yet", "Once a department reads an urgent message, its response time shows up here.");
    return;
  }
  departments.sort(function(a, b){ return b.avgSeconds - a.avgSeconds; });
  targetEl.innerHTML = "";
  departments.forEach(function(d){
    var slow = d.avgSeconds > RESPONSE_SLOW_SECONDS;
    var row = document.createElement("div");
    row.className = "resp-row";
    row.innerHTML =
      '<span class="resp-dot'+(slow?' slow':'')+'"></span>'+
      '<span class="resp-body">'+
        '<span class="resp-name">'+esc(DEPTS[d.deptId] ? DEPTS[d.deptId].name : d.deptId)+'</span>'+
        '<span class="resp-sub">'+d.count+' urgent message'+(d.count === 1 ? "" : "s")+'</span>'+
      '</span>'+
      '<span class="resp-time'+(slow?' slow':'')+'">'+fmtDuration(d.avgSeconds)+'</span>';
    targetEl.appendChild(row);
  });
}

responseBtn.addEventListener("click", function(){
  responseList.innerHTML = '<div class="handover-empty">Loading…</div>';
  responseOverlay.hidden = false;
  apiGet('/api/response-times').then(function(res){
    renderResponseTimes(res.departments);
  }).catch(function(){
    responseList.innerHTML = '<div class="handover-empty">Couldn\'t load response times.</div>';
  });
});
responseClose.addEventListener("click", function(){ responseOverlay.hidden = true; });
responseOverlay.addEventListener("click", function(e){ if(e.target === responseOverlay) responseOverlay.hidden = true; });

/* ---------------- Ops overview (admin): escalations, ownership, blocker chains, exceptions ---------------- */
var opsOverviewBtn = document.getElementById("opsOverviewBtn");
var opsOverviewOverlay = document.getElementById("opsOverviewOverlay");
var opsOverviewClose = document.getElementById("opsOverviewClose");
var opsOverviewBody = document.getElementById("opsOverviewBody");

function opsItemPreview(m){
  if(m.type === "text") return m.body || "";
  if(m.type === "image") return "a photo";
  if(m.type === "file") return m.fileName || "a file";
  return "a voice message";
}

function renderOpsOverview(data){
  var html = "";

  html += '<div class="ops-section-label">Exceptions</div>';
  html += '<div class="ops-exceptions-row">'+
    '<div class="ops-exception-tile"><span class="ops-exception-n">'+data.exceptions.openTickets+'</span><span class="ops-exception-label">Rooms/jobs still open</span></div>'+
    '<div class="ops-exception-tile"><span class="ops-exception-n">'+data.exceptions.openGuestRequests+'</span><span class="ops-exception-label">Guest requests unresolved</span></div>'+
    '<div class="ops-exception-tile"><span class="ops-exception-n">'+data.blockerChains.length+'</span><span class="ops-exception-label">Blocked chains right now</span></div>'+
  '</div>';

  var needsAttention = data.escalatedMessages.filter(function(m){ return m.escalationLevel >= 2; })
    .concat(data.escalatedTickets.filter(function(t){ return t.escalationLevel >= 2; }));
  var atRisk = data.escalatedMessages.filter(function(m){ return m.escalationLevel === 1; })
    .concat(data.escalatedTickets.filter(function(t){ return t.escalationLevel === 1; }));

  function opsRow(item, isTicket){
    var name = isTicket ? item.description : opsItemPreview(item);
    var sub = isTicket ? "Maintenance ticket · unclaimed" : (DEPTS[item.from] ? DEPTS[item.from].name : item.from) + " → " + (DEPTS[item.to] ? DEPTS[item.to].name : item.to);
    return '<div class="ops-row'+(item.escalationLevel >= 2 ? ' breach' : ' risk')+'">'+
      '<span class="ops-row-dot"></span>'+
      '<span class="ops-row-body"><span class="ops-row-name">'+esc(name)+'</span><span class="ops-row-sub">'+esc(sub)+'</span></span>'+
      (item.affectsGuest ? '<span class="ops-guest-tag">Guest</span>' : '')+
    '</div>';
  }

  html += '<div class="ops-section-label">Needs attention now</div>';
  html += needsAttention.length
    ? '<div class="ops-list">'+needsAttention.map(function(i){ return opsRow(i, !!i.description); }).join("")+'</div>'
    : '<div class="ops-empty-line">Nothing has gone silent this long. Good.</div>';

  html += '<div class="ops-section-label">At risk</div>';
  html += atRisk.length
    ? '<div class="ops-list">'+atRisk.map(function(i){ return opsRow(i, !!i.description); }).join("")+'</div>'
    : '<div class="ops-empty-line">Nothing approaching its window right now.</div>';

  html += '<div class="ops-section-label">Blocked chains</div>';
  html += data.blockerChains.length
    ? '<div class="ops-list">'+data.blockerChains.map(function(chain){
        var path = chain.map(function(b){ return DEPTS[b.departmentId] ? DEPTS[b.departmentId].name : b.departmentId; });
        var last = chain[chain.length - 1];
        var finalTarget = DEPTS[last.waitingOn] ? DEPTS[last.waitingOn].name : last.waitingOn;
        return '<div class="ops-row risk"><span class="ops-row-dot"></span><span class="ops-row-body"><span class="ops-row-name">'+esc(path.join(" → "))+' → '+esc(finalTarget)+'</span><span class="ops-row-sub">'+chain.length+' department'+(chain.length===1?"":"s")+' blocked in a row</span></span></div>';
      }).join("")+'</div>'
    : '<div class="ops-empty-line">No chains of blocked departments right now.</div>';

  html += '<div class="ops-section-label">No owner assigned</div>';
  html += data.unownedTickets.length
    ? '<div class="ops-list">'+data.unownedTickets.map(function(t){
        return '<div class="ops-row"><span class="ops-row-dot none"></span><span class="ops-row-body"><span class="ops-row-name">'+esc(t.description)+'</span><span class="ops-row-sub">'+MAINT_STATUS_LABEL[t.status]+' · nobody\'s claimed this</span></span></div>';
      }).join("")+'</div>'
    : '<div class="ops-empty-line">Every open job has someone on it.</div>';

  opsOverviewBody.innerHTML = html;
}

opsOverviewBtn.addEventListener("click", function(){
  opsOverviewBody.innerHTML = '<div class="handover-empty">Loading…</div>';
  opsOverviewOverlay.hidden = false;
  apiGet('/api/ops-overview').then(function(res){
    renderOpsOverview(res);
  }).catch(function(){
    opsOverviewBody.innerHTML = '<div class="handover-empty">Couldn\'t load the overview.</div>';
  });
});
opsOverviewClose.addEventListener("click", function(){ opsOverviewOverlay.hidden = true; });
opsOverviewOverlay.addEventListener("click", function(e){ if(e.target === opsOverviewOverlay) opsOverviewOverlay.hidden = true; });

/* ---------------- Blockers ("waiting on" chains) ---------------- */
var blockersBtn = document.getElementById("blockersBtn");
var blockersOverlay = document.getElementById("blockersOverlay");
var blockersClose = document.getElementById("blockersClose");
var blockerList = document.getElementById("blockerList");
var blockerAddForm = document.getElementById("blockerAddForm");
var blockerWaitingOn = document.getElementById("blockerWaitingOn");
var blockerReason = document.getElementById("blockerReason");
var blockerError = document.getElementById("blockerError");

function renderBlockerList(blockers){
  if(!blockers.length){
    blockerList.innerHTML = panelEmptyHtml(PANEL_EMPTY_ICONS.clock, "Nothing's blocked right now", "When a department is waiting on someone else, it'll show up here.");
    return;
  }
  blockerList.innerHTML = "";
  blockers.forEach(function(b){
    var row = document.createElement("div");
    row.className = "blocker-row";
    var waitingOnLabel = DEPTS[b.waitingOn] ? DEPTS[b.waitingOn].name : b.waitingOn;
    var canResolve = b.departmentId === AUTH.staff.departmentId || AUTH.staff.isAdmin;
    row.innerHTML =
      '<div class="blocker-row-body">'+
        '<span class="blocker-row-name">'+esc(DEPTS[b.departmentId] ? DEPTS[b.departmentId].name : b.departmentId)+' is waiting on '+esc(waitingOnLabel)+'</span>'+
        (b.reason ? '<span class="blocker-row-reason">'+esc(b.reason)+'</span>' : '')+
      '</div>'+
      (canResolve ? '<button type="button" class="blocker-resolve-btn">Clear</button>' : '');
    if(canResolve){
      row.querySelector(".blocker-resolve-btn").addEventListener("click", function(){
        apiSend('/api/blockers/' + encodeURIComponent(b.id) + '/resolve', 'POST', {}).then(function(){
          loadBlockers();
          showToast("Cleared");
        }).catch(function(){ showToast("Couldn't clear that"); });
      });
    }
    blockerList.appendChild(row);
  });
}

function loadBlockers(){
  apiGet('/api/blockers').then(function(res){
    renderBlockerList(res.blockers);
  }).catch(function(){
    blockerList.innerHTML = '<div class="handover-empty">Couldn\'t load blockers.</div>';
  });
}

blockersBtn.addEventListener("click", function(){
  blockerWaitingOn.innerHTML = DEPT_ORDER.filter(function(id){ return id !== STATE.self; }).map(function(id){
    return '<option value="'+id+'">'+esc(DEPTS[id].name)+'</option>';
  }).join("") + '<option value="">Something else (describe below)</option>';
  blockerError.textContent = "";
  blockerList.innerHTML = '<div class="handover-empty">Loading…</div>';
  blockersOverlay.hidden = false;
  loadBlockers();
});
blockersClose.addEventListener("click", function(){ blockersOverlay.hidden = true; });
blockersOverlay.addEventListener("click", function(e){ if(e.target === blockersOverlay) blockersOverlay.hidden = true; });

blockerAddForm.addEventListener("submit", function(e){
  e.preventDefault();
  blockerError.textContent = "";
  var deptChoice = blockerWaitingOn.value;
  var reasonText = blockerReason.value.trim();
  var waitingOn = deptChoice || reasonText;
  if(!waitingOn){ blockerError.textContent = "Say what you're waiting on"; return; }
  apiSend('/api/blockers', 'POST', { waitingOn: waitingOn, reason: deptChoice ? reasonText : null }).then(function(){
    blockerReason.value = "";
    loadBlockers();
    showToast("Marked as blocked");
  }).catch(function(err){
    blockerError.textContent = err.message || "Couldn't save that";
  });
});

/* ---------------- Events (ad-hoc group chats) ---------------- */
var eventPalette = document.getElementById("eventPalette");
var eventList = document.getElementById("eventList");
var eventsActiveSection = document.getElementById("eventsActiveSection");
var eventsPastSection = document.getElementById("eventsPastSection");
var eventsFilterRow = document.getElementById("eventsFilterRow");
var pastEventsLabel = document.getElementById("pastEventsLabel");
var pastEventsHint = document.getElementById("pastEventsHint");
var pastEventList = document.getElementById("pastEventList");
var eventError = document.getElementById("eventError");
var eventDropZone = document.getElementById("eventDropZone");
var eventDropZoneLabel = document.getElementById("eventDropZoneLabel");
var newEventForm = document.getElementById("newEventForm");
var newEventName = document.getElementById("newEventName");

STATE.eventsFilter = "active";
eventsFilterRow.addEventListener("click", function(e){
  var btn = e.target.closest(".chat-filter-chip");
  if(!btn) return;
  STATE.eventsFilter = btn.dataset.filter;
  eventsFilterRow.querySelectorAll(".chat-filter-chip").forEach(function(c){ c.classList.toggle("active", c === btn); });
  eventsActiveSection.hidden = STATE.eventsFilter !== "active";
  eventsPastSection.hidden = STATE.eventsFilter !== "past";
});

STATE.groups = [];
var pendingLandedGroupId = null;
STATE.activeGroupId = null;
STATE.groupMessages = {};

function loadGroups(){
  return apiGet('/api/groups?self=' + encodeURIComponent(STATE.self)).then(function(res){
    STATE.groups = res.groups;
  }).catch(function(){});
}

function pointOverDropZone(x, y){
  var r = eventDropZone.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function attachDragChip(chipEl, onDrop, opts){
  var AXIS_THRESHOLD = 8;
  var startX = 0, startY = 0, lastX = 0, lastY = 0, pointerId = null, dragging = false, aborted = false, axisPending = false, ghost = null, startScrollLeft = 0;

  function moveGhost(x, y){ if(ghost){ ghost.style.left = x + "px"; ghost.style.top = y + "px"; } }
  function clearCardHighlights(){
    document.querySelectorAll(".event-card.drag-over").forEach(function(c){ c.classList.remove("drag-over"); });
  }
  function liftNow(x, y){
    dragging = true;
    chipEl.classList.remove("pressing");
    if(navigator.vibrate) navigator.vibrate(10);
    ghost = chipEl.cloneNode(true);
    ghost.classList.add("drag-ghost");
    if(opts && opts.isCard) ghost.classList.add("drag-ghost-card");
    ghost.style.width = chipEl.offsetWidth + "px";
    document.body.appendChild(ghost);
    chipEl.classList.add("dragging");
    moveGhost(x, y);
    if(opts && opts.isMember){
      if(opts.dropLabel) eventDropZoneLabel.textContent = opts.dropLabel;
      eventDropZone.classList.add("show");
    }
  }
  function teardown(){
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    pointerId = null;
  }
  function endDragVisuals(){
    chipEl.classList.remove("dragging");
    chipEl.classList.remove("pressing");
    if(ghost){ ghost.remove(); ghost = null; }
    eventDropZone.classList.remove("show");
    eventDropZone.classList.remove("hover");
    eventDropZoneLabel.textContent = "Drop to remove";
    clearCardHighlights();
    dragging = false;
  }
  function onMove(ev){
    if(ev.pointerId !== pointerId) return;
    lastX = ev.clientX; lastY = ev.clientY;
    var dx = ev.clientX - startX, dy = ev.clientY - startY;
    if(aborted){
      if(opts && opts.scrollContainer) opts.scrollContainer.scrollLeft = startScrollLeft - dx;
      return;
    }
    if(axisPending){
      if(Math.abs(dx) < AXIS_THRESHOLD && Math.abs(dy) < AXIS_THRESHOLD) return;
      axisPending = false;
      if(Math.abs(dx) > Math.abs(dy) * 1.6){
        aborted = true;
        endDragVisuals();
        if(opts && opts.scrollContainer) opts.scrollContainer.scrollLeft = startScrollLeft - dx;
        return;
      }
      liftNow(ev.clientX, ev.clientY);
    }
    ev.preventDefault();
    moveGhost(ev.clientX, ev.clientY);
    if(opts && opts.isMember){
      eventDropZone.classList.toggle("hover", pointOverDropZone(ev.clientX, ev.clientY));
    } else {
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      var cardEl = el && el.closest ? el.closest(".event-card[data-group-id]") : null;
      clearCardHighlights();
      if(cardEl) cardEl.classList.add("drag-over");
    }
  }
  function onCancel(ev){
    if(ev.pointerId !== pointerId) return;
    var wasDragging = dragging;
    teardown();
    if(wasDragging) endDragVisuals();
  }
  function onUp(ev){
    if(ev.pointerId !== pointerId) return;
    var wasDragging = dragging && !aborted;
    var dropX = (ev.clientX || lastX), dropY = (ev.clientY || lastY);
    teardown();
    if(!wasDragging) return;
    if(opts && opts.isMember){
      var overZone = pointOverDropZone(dropX, dropY);
      if(overZone && navigator.vibrate) navigator.vibrate(18);
      endDragVisuals();
      if(overZone) onDrop();
    } else {
      var el = document.elementFromPoint(dropX, dropY);
      var cardEl = el && el.closest ? el.closest(".event-card[data-group-id]") : null;
      endDragVisuals();
      if(cardEl){
        if(navigator.vibrate) navigator.vibrate(18);
        var landedGroupId = cardEl.getAttribute("data-group-id");
        pendingLandedGroupId = landedGroupId;
        setTimeout(function(){
          if(pendingLandedGroupId === landedGroupId) pendingLandedGroupId = null;
          var el = eventList.querySelector('.event-card[data-group-id="'+landedGroupId+'"]');
          if(el) el.classList.remove("landed");
        }, 450);
        onDrop(landedGroupId);
      }
    }
  }
  chipEl.addEventListener("pointerdown", function(e){
    if(e.button !== undefined && e.button !== 0) return;
    if(opts && opts.ignoreSelector && e.target.closest(opts.ignoreSelector)) return;
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    aborted = false;
    startScrollLeft = opts && opts.scrollContainer ? opts.scrollContainer.scrollLeft : 0;
    chipEl.classList.add("pressing");
    if(opts && opts.scrollGuard === "horizontal"){
      axisPending = true;
    } else {
      axisPending = false;
      liftNow(startX, startY);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  });
}

function joinGroup(groupId, deptId){
  var deptName = DEPTS[deptId] ? DEPTS[deptId].name : deptId;
  var g = STATE.groups.find(function(x){ return x.id === groupId; });
  var alreadyMember = g && g.members.indexOf(deptId) !== -1;
  if(g && !alreadyMember){
    g.members.push(deptId);
    g.isMember = g.isMember || deptId === STATE.self;
    renderEventList();
  }
  showToast(deptName + " joined");
  apiSend('/api/groups/' + encodeURIComponent(groupId) + '/join', 'POST', { self: deptId }).then(function(){
    return loadGroups();
  }).then(renderEventList).catch(function(){
    if(g && !alreadyMember){
      var idx = g.members.indexOf(deptId);
      if(idx !== -1) g.members.splice(idx, 1);
      renderEventList();
    }
    showToast("Couldn't add them");
  });
}
function leaveGroup(groupId, deptId){
  var deptName = DEPTS[deptId] ? DEPTS[deptId].name : deptId;
  var g = STATE.groups.find(function(x){ return x.id === groupId; });
  var idx = g ? g.members.indexOf(deptId) : -1;
  if(g && idx !== -1){
    g.members.splice(idx, 1);
    renderEventList();
  }
  showToast(deptName + " left the event");
  apiSend('/api/groups/' + encodeURIComponent(groupId) + '/leave', 'POST', { self: deptId }).then(function(){
    return loadGroups();
  }).then(renderEventList).catch(function(){
    if(g && idx !== -1){
      g.members.splice(idx, 0, deptId);
      renderEventList();
    }
    showToast("Couldn't remove them");
  });
}
function renderEventPalette(){
  eventPalette.innerHTML = "";
  DEPT_ORDER.forEach(function(id){
    var chip = document.createElement("div");
    chip.className = "event-chip";
    chip.innerHTML =
      '<div class="event-chip-avatar" style="'+avatarStyleAttr(id)+'">'+avatarInnerHtml(id)+'</div>'+
      '<div class="event-chip-label">'+esc((DEPTS[id] ? DEPTS[id].initials : id))+'</div>';
    attachDragChip(chip, function(groupId){
      if(groupId) joinGroup(groupId, id);
    }, { isMember: false, scrollGuard: "horizontal", scrollContainer: eventPalette });
    eventPalette.appendChild(chip);
  });
}

function deleteEmptyEvent(groupId){
  showConfirm({ title: "Delete this event?", body: "There's nothing in it yet, so this can't be undone.", confirmLabel: "Delete" }).then(function(ok){
    if(!ok) return;
    apiDelete('/api/groups/' + encodeURIComponent(groupId)).then(function(){
      return loadGroups();
    }).then(function(){
      if(STATE.activeGroupId === groupId){ STATE.activeGroupId = null; closeThreadView(); }
      renderEventList();
      showToast("Event deleted");
    }).catch(function(err){
      showToast(err.message || "Couldn't delete that event");
    });
  });
}

function archiveEvent(groupId){
  showConfirm({
    title: "End this event?",
    body: "It'll become read only and move to Past events, kept there for training.",
    confirmLabel: "End event",
    neutral: true,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  }).then(function(ok){
    if(!ok) return;
    apiSend('/api/groups/' + encodeURIComponent(groupId) + '/archive', 'POST', {}).then(function(){
      return loadGroups();
    }).then(function(){
      renderEventList();
      if(STATE.activeGroupId === groupId){ renderHeader(); updateComposerLock(); }
      showToast("Event ended");
    }).catch(function(err){
      showToast(err.message || "Couldn't end that event");
    });
  });
}

function shareEvent(groupId){
  showConfirm({
    title: "Share this event with every department head?",
    body: "They'll be able to read back through it.",
    confirmLabel: "Share",
    neutral: true,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
  }).then(function(ok){
    if(!ok) return;
    apiSend('/api/groups/' + encodeURIComponent(groupId) + '/share', 'POST', {}).then(function(){
      return loadGroups();
    }).then(function(){
      renderEventList();
      if(STATE.activeGroupId === groupId) renderHeader();
      showToast("Shared with every department");
    }).catch(function(err){
      showToast(err.message || "Couldn't share that event");
    });
  });
}

function renderEventList(){
  var active = STATE.groups.filter(function(g){ return !g.archivedAt; });
  var past = STATE.groups.filter(function(g){ return !!g.archivedAt; });

  eventList.innerHTML = "";
  if(!active.length){
    eventList.innerHTML = '<div class="event-empty">No events yet. Create one above.</div>';
  }
  active.forEach(function(g){
    var card = document.createElement("div");
    card.className = "event-card" + (g.id === pendingLandedGroupId ? " landed" : "");
    card.setAttribute("data-group-id", g.id);
    var membersHtml = g.members.map(function(deptId){
      return '<div class="event-member-chip" data-dept-id="'+deptId+'">'+
        '<div class="event-member-avatar" style="'+avatarStyleAttr(deptId)+'">'+avatarInnerHtml(deptId)+'</div>'+
        '<div class="event-member-label">'+esc((DEPTS[deptId] ? DEPTS[deptId].initials : deptId))+'</div>'+
      '</div>';
    }).join("");
    var canManage = g.createdBy === STATE.self || (AUTH.staff && AUTH.staff.isAdmin);
    var isEmpty = !g.lastMessage;
    card.innerHTML =
      '<div class="event-card-head">'+
        '<span class="event-card-name">'+esc(g.name)+(g.unreadCount ? ' <span class="event-card-badge">'+g.unreadCount+'</span>' : '')+'</span>'+
        '<div class="event-card-actions">'+
          (canManage && isEmpty ? '<button type="button" class="event-card-end event-card-delete" data-group-id="'+g.id+'">Delete</button>' : '')+
          (canManage && !isEmpty ? '<button type="button" class="event-card-end" data-group-id="'+g.id+'">End event</button>' : '')+
          '<button type="button" class="event-card-details-btn" data-group-id="'+g.id+'">'+(canManage ? "Edit details" : "Details")+'</button>'+
          '<button type="button" class="event-card-open" data-group-id="'+g.id+'">Open chat '+
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'+
          '</button>'+
        '</div>'+
      '</div>'+
      '<div class="event-card-members">'+membersHtml+'</div>'+
      (g.isMember ? '' : '<div class="event-card-hint">Drag a department here to add them</div>')+
      '<div class="event-card-hint event-card-tap-hint">'+(canManage ? "Tap for the banner, stations & run sheet" : "Tap for event details")+'</div>';
    eventList.appendChild(card);

    card.addEventListener("click", function(e){
      if(e.target.closest(".event-card-open, .event-card-end, .event-card-delete, .event-card-details-btn, .event-member-chip")) return;
      openEventDetail(g.id);
    });
    card.querySelectorAll(".event-member-chip").forEach(function(chip){
      var deptId = chip.getAttribute("data-dept-id");
      attachDragChip(chip, function(){ leaveGroup(g.id, deptId); }, { isMember: true, dropLabel: "Drop to remove" });
    });
    if(canManage && isEmpty){
      card.querySelector(".event-card-delete").addEventListener("click", function(e){ e.stopPropagation(); deleteEmptyEvent(g.id); });
    }
    if(canManage && !isEmpty){
      card.querySelector(".event-card-end").addEventListener("click", function(e){ e.stopPropagation(); archiveEvent(g.id); });
    }
    card.querySelector(".event-card-details-btn").addEventListener("click", function(e){ e.stopPropagation(); openEventDetail(g.id); });
    card.querySelector(".event-card-open").addEventListener("click", function(e){ e.stopPropagation(); openGroupThread(g.id); });
  });

  var pastFilterBtn = eventsFilterRow.querySelector('[data-filter="past"]');
  pastFilterBtn.textContent = past.length ? "Past (" + past.length + ")" : "Past";
  pastEventsLabel.hidden = true;
  pastEventsHint.hidden = !past.length;
  pastEventList.innerHTML = past.length ? "" : '<div class="event-empty">No past events yet.</div>';
  past.forEach(function(g){
    var card = document.createElement("div");
    card.className = "event-card past";
    var membersHtml = g.members.map(function(deptId){
      return '<div class="event-member-chip" data-dept-id="'+deptId+'">'+
        '<div class="event-member-avatar" style="'+avatarStyleAttr(deptId)+'">'+avatarInnerHtml(deptId)+'</div>'+
        '<div class="event-member-label">'+esc((DEPTS[deptId] ? DEPTS[deptId].initials : deptId))+'</div>'+
      '</div>';
    }).join("");
    var canShare = AUTH.staff && AUTH.staff.isAdmin && !g.sharedAt;
    card.innerHTML =
      '<div class="event-card-head">'+
        '<span class="event-card-name">'+esc(g.name)+'</span>'+
        '<div class="event-card-actions">'+
          '<span class="event-card-ended-pill">Ended</span>'+
          (canShare ? '<button type="button" class="event-card-end" data-group-id="'+g.id+'">Share</button>' : '')+
          '<button type="button" class="event-card-details-btn" data-group-id="'+g.id+'">Details</button>'+
          '<button type="button" class="event-card-open" data-group-id="'+g.id+'">Open chat '+
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'+
          '</button>'+
        '</div>'+
      '</div>'+
      '<div class="event-card-members">'+membersHtml+'</div>'+
      (canShare ? '<div class="event-card-hint">Only you can see this. Share to give every department head access.</div>' : '')+
      '<div class="event-card-hint event-card-tap-hint">Tap for event details</div>';
    pastEventList.appendChild(card);
    card.addEventListener("click", function(e){
      if(e.target.closest(".event-card-open, .event-card-end, .event-card-details-btn, .event-member-chip")) return;
      openEventDetail(g.id);
    });
    card.querySelector(".event-card-details-btn").addEventListener("click", function(e){ e.stopPropagation(); openEventDetail(g.id); });
    if(canShare){
      card.querySelector(".event-card-end").addEventListener("click", function(e){ e.stopPropagation(); shareEvent(g.id); });
    }
    card.querySelector(".event-card-open").addEventListener("click", function(e){ e.stopPropagation(); openGroupThread(g.id); });
  });
}

/* ---------------- Event detail: banner + stations + run sheet ---------------- */
var STATION_ICONS = {
  fnb: '<path d="M8 2h8l-1 7a3 3 0 0 1-6 0z"/><path d="M12 13v7"/><path d="M8 20h8"/>',
  catering: '<path d="M6 2v8a2 2 0 0 0 4 0V2"/><path d="M8 10v12"/><path d="M17 2c-1.5 0-3 1.5-3 4s1.5 4 3 4v10"/>',
  engineering: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  housekeeping: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  security: '<path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6z"/>',
  guest: '<path d="M12 3l2.6 5.8 6.2.6-4.7 4.2 1.4 6.1L12 16.9 6.5 19.7l1.4-6.1-4.7-4.2 6.2-.6z"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  general: '<path d="M5 3v18"/><path d="M5 4h13l-3 5 3 5H5"/>'
};
var STATION_ICON_ORDER = ["fnb","catering","engineering","housekeeping","security","guest","music","general"];
function stationIconSvg(key){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+(STATION_ICONS[key] || STATION_ICONS.general)+'</svg>';
}

var eventDetailOverlay = document.getElementById("eventDetailOverlay");
var eventDetailBody = document.getElementById("eventDetailBody");
var eventDetailName = document.getElementById("eventDetailName");
var eventDetailClose = document.getElementById("eventDetailClose");
var eventDetailRunsheetOpen = false;
STATE.eventDetailGroupId = null;
STATE.eventDetailStations = [];
STATE.eventDetailRunsheet = [];

function openEventDetail(groupId){
  var g = STATE.groups.find(function(x){ return x.id === groupId; });
  if(!g) return;
  STATE.eventDetailGroupId = groupId;
  eventDetailRunsheetOpen = false;
  eventDetailName.textContent = g.name;
  eventDetailOverlay.hidden = false;
  appToast.classList.add("above-modal");
  eventDetailBody.innerHTML = '<div class="event-detail-loading">Loading…</div>';
  Promise.all([
    apiGet('/api/groups/' + encodeURIComponent(groupId) + '/stations'),
    apiGet('/api/groups/' + encodeURIComponent(groupId) + '/runsheet')
  ]).then(function(results){
    STATE.eventDetailStations = results[0].stations;
    STATE.eventDetailRunsheet = results[1].items;
    renderEventDetailBody();
  }).catch(function(err){
    eventDetailBody.innerHTML = '<div class="event-detail-loading">' + esc(err.message || "Couldn't load this event") + '</div>';
  });
}
function closeEventDetail(){
  eventDetailOverlay.hidden = true;
  appToast.classList.remove("above-modal");
  STATE.eventDetailGroupId = null;
}
eventDetailClose.addEventListener("click", closeEventDetail);
eventDetailOverlay.addEventListener("click", function(e){ if(e.target === eventDetailOverlay) closeEventDetail(); });

function currentEventDetailGroup(){
  return STATE.groups.find(function(x){ return x.id === STATE.eventDetailGroupId; });
}
function eventDetailCanManage(){
  var g = currentEventDetailGroup();
  return !!(g && (g.createdBy === STATE.self || (AUTH.staff && AUTH.staff.isAdmin)));
}

function renderEventDetailBody(){
  var g = currentEventDetailGroup();
  if(!g){ closeEventDetail(); return; }
  eventDetailName.textContent = g.name;
  var canManage = eventDetailCanManage();

  function bannerPill(field, iconSvg, valueText, hasValue){
    if(!canManage && !hasValue) return "";
    var tag = canManage ? "button" : "div";
    return '<'+tag+(canManage ? ' type="button"' : '')+' class="event-detail-pill'+(canManage ? '' : ' readonly')+'" data-field="'+field+'">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+iconSvg+'</svg>'+
      '<span>'+esc(valueText)+'</span>'+
    '</'+tag+'>';
  }
  var pillsHtml =
    bannerPill("eventDate", '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/>', g.eventDate || "Add date", !!g.eventDate) +
    bannerPill("guestCount", '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', (g.guestCount || g.guestCount === 0) ? String(g.guestCount) + " guests" : "Add guest count", g.guestCount || g.guestCount === 0) +
    bannerPill("location", '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>', g.location || "Add location", !!g.location);

  var hodsHtml = DEPT_ORDER.filter(function(id){ return id !== STATE.self || true; }).map(function(id){
    return '<div class="event-detail-hod-chip" data-dept-id="'+id+'">'+
      '<div class="event-detail-hod-avatar" style="'+avatarStyleAttr(id)+'">'+avatarInnerHtml(id)+'</div>'+
      '<div class="event-detail-hod-label">'+esc(DEPTS[id] ? DEPTS[id].initials : id)+'</div>'+
    '</div>';
  }).join("");

  var stationsHtml = STATE.eventDetailStations.map(function(s){
    var assignedDept = s.assignedDeptId;
    var canConfirm = assignedDept && (assignedDept === STATE.self || (AUTH.staff && AUTH.staff.isAdmin));
    var assignHtml;
    if(assignedDept){
      assignHtml =
        '<div class="station-assigned-chip" data-dept-id="'+assignedDept+'">'+
          '<div class="station-assigned-avatar" style="'+avatarStyleAttr(assignedDept)+'">'+avatarInnerHtml(assignedDept)+'</div>'+
          '<span class="station-assigned-label">'+esc(DEPTS[assignedDept] ? DEPTS[assignedDept].initials : assignedDept)+'</span>'+
          (s.confirmedAt ? '<span class="station-confirmed-badge" title="Confirmed">'+ACTION_ICONS.check+'</span>' :
            (canConfirm ? '<button type="button" class="station-confirm-btn" data-station-id="'+s.id+'">Confirm</button>' : '<span class="station-pending-badge">Pending</span>')) +
          (canManage ? '<button type="button" class="station-unassign-btn" data-station-id="'+s.id+'" aria-label="Unassign">×</button>' : '') +
        '</div>';
    } else {
      assignHtml = '<div class="station-empty-slot">Drop a department here</div>';
    }
    return '<div class="station-row" data-station-id="'+s.id+'">'+
      '<div class="station-icon">'+stationIconSvg(s.icon)+'</div>'+
      '<div class="station-body">'+
        '<div class="station-title">'+esc(s.title)+'</div>'+
        (s.category ? '<div class="station-category">'+esc(s.category)+'</div>' : '')+
      '</div>'+
      '<div class="station-assign">'+assignHtml+'</div>'+
      (canManage ? '<button type="button" class="station-remove-btn" data-station-id="'+s.id+'" aria-label="Remove station">'+ACTION_ICONS.trash+'</button>' : '')+
    '</div>';
  }).join("") || '<div class="event-detail-empty">No stations yet'+(canManage ? ' — add one below.' : '.')+'</div>';

  var iconPickerHtml = STATION_ICON_ORDER.map(function(key, i){
    return '<button type="button" class="station-icon-choice'+(i===0 ? ' active' : '')+'" data-icon="'+key+'">'+stationIconSvg(key)+'</button>';
  }).join("");

  var runsheetHtml = STATE.eventDetailRunsheet.map(function(item){
    return '<div class="runsheet-row" data-item-id="'+item.id+'">'+
      '<div class="runsheet-time">'+esc(item.timeLabel)+'</div>'+
      '<div class="runsheet-body-text">'+
        '<div class="runsheet-title">'+esc(item.title)+'</div>'+
        (item.description ? '<div class="runsheet-desc">'+esc(item.description)+'</div>' : '')+
      '</div>'+
      (item.teamLabel ? '<div class="runsheet-team">'+esc(item.teamLabel)+'</div>' : '')+
      (canManage ? '<button type="button" class="runsheet-remove-btn" data-item-id="'+item.id+'" aria-label="Remove row">×</button>' : '')+
    '</div>';
  }).join("") || '<div class="event-detail-empty">Nothing on the run sheet yet'+(canManage ? ' — add a row below.' : '.')+'</div>';

  eventDetailBody.innerHTML =
    '<div class="event-detail-banner">'+
      (canManage ? '<button type="button" class="event-detail-desc'+(g.description ? '' : ' placeholder')+'" data-field="description">'+(g.description ? esc(g.description) : "Add a description")+'</button>' : (g.description ? '<div class="event-detail-desc readonly">'+esc(g.description)+'</div>' : ''))+
      '<div class="event-detail-pills">'+pillsHtml+'</div>'+
    '</div>'+
    '<div class="event-detail-section">'+
      '<div class="event-detail-section-head"><h3>Stations</h3></div>'+
      (canManage ? '<p class="event-detail-hint">Drag a department onto a station to assign them.</p>' : '')+
      (canManage ? '<div class="event-detail-hods" id="eventDetailHods">'+hodsHtml+'</div>' : '')+
      '<div class="station-list" id="stationList">'+stationsHtml+'</div>'+
      (canManage ?
        '<button type="button" class="event-detail-add-btn" id="stationAddToggle">+ Add station</button>'+
        '<div class="station-add-form" id="stationAddForm" hidden>'+
          '<div class="station-icon-picker">'+iconPickerHtml+'</div>'+
          '<input type="text" id="stationTitleInput" placeholder="Station name, e.g. Banqueting &amp; Wine Service" maxlength="80">'+
          '<input type="text" id="stationCategoryInput" placeholder="Category (optional), e.g. Food &amp; Beverage" maxlength="60">'+
          '<button type="button" class="admin-add-btn" id="stationAddSubmit">Add station</button>'+
        '</div>'
      : '')+
    '</div>'+
    '<div class="event-detail-section runsheet-section">'+
      '<button type="button" class="runsheet-toggle" id="runsheetToggle">'+
        '<h3>Run Sheet</h3>'+
        '<svg class="runsheet-chevron'+(eventDetailRunsheetOpen ? ' open' : '')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'+
      '</button>'+
      '<div class="runsheet-body" id="runsheetBody"'+(eventDetailRunsheetOpen ? '' : ' hidden')+'>'+
        '<div class="runsheet-list" id="runsheetList">'+runsheetHtml+'</div>'+
        (canManage ?
          '<button type="button" class="event-detail-add-btn" id="runsheetAddToggle">+ Add to run sheet</button>'+
          '<div class="runsheet-add-form" id="runsheetAddForm" hidden>'+
            '<input type="text" id="runsheetTimeInput" placeholder="Time, e.g. 14:30" maxlength="20">'+
            '<input type="text" id="runsheetTitleInput" placeholder="What happens, e.g. Wedding Ceremony" maxlength="100">'+
            '<input type="text" id="runsheetTeamInput" placeholder="Team (optional), e.g. F&amp;B and Culinary" maxlength="60">'+
            '<button type="button" class="admin-add-btn" id="runsheetAddSubmit">Add row</button>'+
          '</div>'
        : '')+
      '</div>'+
    '</div>';

  wireEventDetailInteractions(canManage);
}

function wireEventDetailInteractions(canManage){
  if(canManage){
    var descBtn = eventDetailBody.querySelector('.event-detail-desc');
    if(descBtn){
      descBtn.addEventListener("click", function(){ editEventBannerField("description", "Event description", currentEventDetailGroup().description || ""); });
    }
    eventDetailBody.querySelectorAll(".event-detail-pill").forEach(function(btn){
      btn.addEventListener("click", function(){
        var field = btn.getAttribute("data-field");
        var g = currentEventDetailGroup();
        if(field === "eventDate") editEventBannerField("eventDate", "Date & time", g.eventDate || "");
        else if(field === "guestCount") editEventBannerField("guestCount", "Number of guests", g.guestCount || g.guestCount === 0 ? String(g.guestCount) : "");
        else if(field === "location") editEventBannerField("location", "Location", g.location || "");
      });
    });
  }

  if(canManage){
    var hodsWrap = document.getElementById("eventDetailHods");
    if(hodsWrap){
      hodsWrap.querySelectorAll(".event-detail-hod-chip").forEach(function(chip){
        var deptId = chip.getAttribute("data-dept-id");
        attachStationDragChip(chip, deptId);
      });
    }
  }

  eventDetailBody.querySelectorAll(".station-confirm-btn").forEach(function(btn){
    btn.addEventListener("click", function(){ confirmStation(btn.getAttribute("data-station-id")); });
  });
  eventDetailBody.querySelectorAll(".station-unassign-btn").forEach(function(btn){
    btn.addEventListener("click", function(){ assignStation(btn.getAttribute("data-station-id"), null); });
  });
  eventDetailBody.querySelectorAll(".station-remove-btn").forEach(function(btn){
    btn.addEventListener("click", function(){ removeStation(btn.getAttribute("data-station-id")); });
  });

  var stationAddToggle = document.getElementById("stationAddToggle");
  var stationAddForm = document.getElementById("stationAddForm");
  if(stationAddToggle){
    var selectedIcon = STATION_ICON_ORDER[0];
    stationAddToggle.addEventListener("click", function(){
      stationAddForm.hidden = !stationAddForm.hidden;
      if(!stationAddForm.hidden) document.getElementById("stationTitleInput").focus();
    });
    stationAddForm.querySelectorAll(".station-icon-choice").forEach(function(btn){
      btn.addEventListener("click", function(){
        stationAddForm.querySelectorAll(".station-icon-choice").forEach(function(b){ b.classList.remove("active"); });
        btn.classList.add("active");
        selectedIcon = btn.getAttribute("data-icon");
      });
    });
    document.getElementById("stationAddSubmit").addEventListener("click", function(){
      var title = document.getElementById("stationTitleInput").value.trim();
      if(!title) return;
      var category = document.getElementById("stationCategoryInput").value.trim();
      addStation(title, category, selectedIcon);
    });
  }

  eventDetailBody.querySelectorAll(".runsheet-remove-btn").forEach(function(btn){
    btn.addEventListener("click", function(){ removeRunsheetItem(btn.getAttribute("data-item-id")); });
  });

  var runsheetToggle = document.getElementById("runsheetToggle");
  var runsheetBody = document.getElementById("runsheetBody");
  runsheetToggle.addEventListener("click", function(){
    eventDetailRunsheetOpen = !eventDetailRunsheetOpen;
    runsheetBody.hidden = !eventDetailRunsheetOpen;
    runsheetToggle.querySelector(".runsheet-chevron").classList.toggle("open", eventDetailRunsheetOpen);
  });

  var runsheetAddToggle = document.getElementById("runsheetAddToggle");
  if(runsheetAddToggle){
    var runsheetAddForm = document.getElementById("runsheetAddForm");
    runsheetAddToggle.addEventListener("click", function(){
      runsheetAddForm.hidden = !runsheetAddForm.hidden;
      if(!runsheetAddForm.hidden) document.getElementById("runsheetTimeInput").focus();
    });
    document.getElementById("runsheetAddSubmit").addEventListener("click", function(){
      var time = document.getElementById("runsheetTimeInput").value.trim();
      var title = document.getElementById("runsheetTitleInput").value.trim();
      if(!time || !title) return;
      var team = document.getElementById("runsheetTeamInput").value.trim();
      addRunsheetItem(time, title, team);
    });
  }
}

function editEventBannerField(field, label, currentValue){
  showPrompt({ title: label, value: currentValue, placeholder: label, confirmLabel: "Save" }).then(function(value){
    if(value === null) return;
    var payload = {};
    if(field === "guestCount"){
      var n = value.trim() === "" ? null : parseInt(value, 10);
      payload.guestCount = (n === null || isNaN(n)) ? null : n;
    } else {
      payload[field] = value.trim();
    }
    apiSend('/api/groups/' + encodeURIComponent(STATE.eventDetailGroupId), 'PATCH', payload).then(function(res){
      var idx = STATE.groups.findIndex(function(g){ return g.id === STATE.eventDetailGroupId; });
      if(idx !== -1) STATE.groups[idx] = Object.assign({}, STATE.groups[idx], res.group);
      renderEventDetailBody();
    }).catch(function(err){ showToast(err.message || "Couldn't save that"); });
  });
}

function assignStation(stationId, deptId){
  apiSend('/api/stations/' + encodeURIComponent(stationId), 'PATCH', { assignedDeptId: deptId }).then(function(res){
    var idx = STATE.eventDetailStations.findIndex(function(s){ return s.id === stationId; });
    if(idx !== -1) STATE.eventDetailStations[idx] = res.station;
    renderEventDetailBody();
  }).catch(function(err){ showToast(err.message || "Couldn't assign that station"); });
}
function confirmStation(stationId){
  apiSend('/api/stations/' + encodeURIComponent(stationId), 'PATCH', { confirm: true }).then(function(res){
    var idx = STATE.eventDetailStations.findIndex(function(s){ return s.id === stationId; });
    if(idx !== -1) STATE.eventDetailStations[idx] = res.station;
    renderEventDetailBody();
    showToast("Station confirmed");
  }).catch(function(err){ showToast(err.message || "Couldn't confirm that station"); });
}
function addStation(title, category, icon){
  apiSend('/api/groups/' + encodeURIComponent(STATE.eventDetailGroupId) + '/stations', 'POST', { title: title, category: category, icon: icon }).then(function(res){
    STATE.eventDetailStations.push(res.station);
    renderEventDetailBody();
  }).catch(function(err){ showToast(err.message || "Couldn't add that station"); });
}
function removeStation(stationId){
  showConfirm({ title: "Remove this station?", confirmLabel: "Remove" }).then(function(ok){
    if(!ok) return;
    apiDelete('/api/stations/' + encodeURIComponent(stationId)).then(function(){
      STATE.eventDetailStations = STATE.eventDetailStations.filter(function(s){ return s.id !== stationId; });
      renderEventDetailBody();
    }).catch(function(err){ showToast(err.message || "Couldn't remove that station"); });
  });
}

function addRunsheetItem(timeLabel, title, teamLabel){
  apiSend('/api/groups/' + encodeURIComponent(STATE.eventDetailGroupId) + '/runsheet', 'POST', { timeLabel: timeLabel, title: title, teamLabel: teamLabel }).then(function(res){
    STATE.eventDetailRunsheet.push(res.item);
    renderEventDetailBody();
  }).catch(function(err){ showToast(err.message || "Couldn't add that row"); });
}
function removeRunsheetItem(itemId){
  showConfirm({ title: "Remove this row?", confirmLabel: "Remove" }).then(function(ok){
    if(!ok) return;
    apiDelete('/api/runsheet/' + encodeURIComponent(itemId)).then(function(){
      STATE.eventDetailRunsheet = STATE.eventDetailRunsheet.filter(function(i){ return i.id !== itemId; });
      renderEventDetailBody();
    }).catch(function(err){ showToast(err.message || "Couldn't remove that row"); });
  });
}

function attachStationDragChip(chipEl, deptId){
  var pointerId = null, dragging = false, ghost = null;
  function moveGhost(x, y){ if(ghost){ ghost.style.left = x + "px"; ghost.style.top = y + "px"; } }
  function clearHighlights(){ document.querySelectorAll(".station-row.drag-over").forEach(function(r){ r.classList.remove("drag-over"); }); }
  function teardown(){
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    pointerId = null;
  }
  function endVisuals(){
    chipEl.classList.remove("dragging", "pressing");
    if(ghost){ ghost.remove(); ghost = null; }
    clearHighlights();
    dragging = false;
  }
  function onMove(ev){
    if(ev.pointerId !== pointerId) return;
    ev.preventDefault();
    moveGhost(ev.clientX, ev.clientY);
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    var row = el && el.closest ? el.closest(".station-row") : null;
    clearHighlights();
    if(row) row.classList.add("drag-over");
  }
  function onCancel(ev){ if(ev.pointerId !== pointerId) return; teardown(); endVisuals(); }
  function onUp(ev){
    if(ev.pointerId !== pointerId) return;
    var wasDragging = dragging;
    var dropX = ev.clientX, dropY = ev.clientY;
    teardown();
    if(!wasDragging) return;
    var el = document.elementFromPoint(dropX, dropY);
    var row = el && el.closest ? el.closest(".station-row") : null;
    endVisuals();
    if(row){
      if(navigator.vibrate) navigator.vibrate(18);
      assignStation(row.getAttribute("data-station-id"), deptId);
    }
  }
  chipEl.addEventListener("pointerdown", function(e){
    if(e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    dragging = true;
    chipEl.classList.add("pressing");
    ghost = chipEl.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.width = chipEl.offsetWidth + "px";
    document.body.appendChild(ghost);
    moveGhost(e.clientX, e.clientY);
    chipEl.classList.add("dragging");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  });
}

newEventForm.addEventListener("submit", function(e){
  e.preventDefault();
  var name = newEventName.value.trim();
  if(!name) return;
  eventError.textContent = "";
  apiSend('/api/groups', 'POST', { self: STATE.self, name: name, memberDepartmentIds: [] }).then(function(){
    newEventName.value = "";
    return loadGroups();
  }).then(renderEventList).catch(function(err){
    eventError.textContent = err.message || "Couldn't create the event";
  });
});

var tabEventsBadge = document.getElementById("tabEventsBadge");
function refreshEventsBadge(){
  loadGroups().then(function(){
    var n = STATE.groups.filter(function(g){ return !g.archivedAt; }).length;
    tabEventsBadge.hidden = n === 0;
    tabEventsBadge.textContent = n > 99 ? "99+" : String(n);
    if(!eventsPage.hidden) renderEventList();
  });
}

function openEventsTab(){
  renderEventPalette();
  eventList.innerHTML = '<div class="event-empty">Loading…</div>';
  refreshEventsBadge();
}

/* ---- Maintenance ticket board ---- */
var maintFeed = document.getElementById("maintFeed");
var newMaintForm = document.getElementById("newMaintForm");
var newMaintRoom = document.getElementById("newMaintRoom");
var newMaintDesc = document.getElementById("newMaintDesc");
var newMaintPhoto = document.getElementById("newMaintPhoto");
var maintPhotoPreview = document.getElementById("maintPhotoPreview");
var maintPhotoPreviewImg = document.getElementById("maintPhotoPreviewImg");
var maintPhotoPreviewVideo = document.getElementById("maintPhotoPreviewVideo");
var maintPhotoRemove = document.getElementById("maintPhotoRemove");
var maintError = document.getElementById("maintError");
var maintPhotoFile = null;
var newMaintGuestPresent = document.getElementById("newMaintGuestPresent");
var newMaintDeadline = document.getElementById("newMaintDeadline");
var maintSelectedPriority = "problem";
var maintPriorityChips = document.querySelectorAll(".maint-priority-chip");
maintPriorityChips.forEach(function(chip){
  chip.addEventListener("click", function(){
    maintSelectedPriority = chip.getAttribute("data-priority");
    maintPriorityChips.forEach(function(c){ c.classList.toggle("active", c === chip); });
  });
});
STATE.tickets = STATE.tickets || [];

var maintOffDutyBanner = document.getElementById("maintOffDutyBanner");
function renderMaintOffDutyBanner(){
  maintOffDutyBanner.hidden = isOnDuty("maintenance");
}

function openMaintenanceTab(){
  maintFeed.innerHTML = '<div class="maint-col-empty">Loading…</div>';
  refreshMaintenanceBadge();
  renderMaintOffDutyBanner();
}

var maintSearchInput = document.getElementById("maintSearchInput");
var maintSearchClear = document.getElementById("maintSearchClear");
STATE.maintSearchTerm = "";
maintSearchInput.addEventListener("input", function(){
  STATE.maintSearchTerm = maintSearchInput.value;
  maintSearchClear.hidden = STATE.maintSearchTerm.length === 0;
  renderMaintenanceBoard();
});
maintSearchClear.addEventListener("click", function(){
  maintSearchInput.value = "";
  STATE.maintSearchTerm = "";
  maintSearchClear.hidden = true;
  renderMaintenanceBoard();
  maintSearchInput.focus();
});

var maintFilterRow = document.getElementById("maintFilterRow");
STATE.maintFilter = "todo";
maintFilterRow.addEventListener("click", function(e){
  var btn = e.target.closest(".chat-filter-chip");
  if(!btn) return;
  STATE.maintFilter = btn.dataset.filter;
  maintFilterRow.querySelectorAll(".chat-filter-chip").forEach(function(c){ c.classList.toggle("active", c === btn); });
  renderMaintenanceBoard();
});

var MAINT_PRIORITY_ORDER = { safety: 0, guest: 1, problem: 2, routine: 3 };
function sortedTickets(){
  var order = { reported: 0, in_progress: 1, fixed: 2 };
  return (STATE.tickets || []).slice().sort(function(a, b){
    if(!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if(order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    var aHasOrder = a.sortOrder != null, bHasOrder = b.sortOrder != null;
    if(aHasOrder && bHasOrder) return a.sortOrder - b.sortOrder;
    if(aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
    var pa = MAINT_PRIORITY_ORDER[a.priority] != null ? MAINT_PRIORITY_ORDER[a.priority] : 2;
    var pb = MAINT_PRIORITY_ORDER[b.priority] != null ? MAINT_PRIORITY_ORDER[b.priority] : 2;
    if(pa !== pb) return pa - pb;
    var aDeadline = a.status !== "fixed" && a.deadline;
    var bDeadline = b.status !== "fixed" && b.deadline;
    if(!!aDeadline !== !!bDeadline) return aDeadline ? -1 : 1;
    if(aDeadline && bDeadline && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
function fmtDeadline(hhmm){
  var parts = hhmm.split(":");
  var h = +parts[0], m = parts[1];
  var period = h >= 12 ? "PM" : "AM";
  var h12 = h % 12; if(h12 === 0) h12 = 12;
  return h12 + ":" + m + " " + period;
}
function isTicketOverdue(t){
  if(!t.deadline || t.status === "fixed") return false;
  var d = new Date();
  var hh = (d.getHours()<10?"0":"")+d.getHours();
  var mm = (d.getMinutes()<10?"0":"")+d.getMinutes();
  return (hh+":"+mm) > t.deadline;
}

function togglePinTicket(id){
  var t = STATE.tickets.find(function(x){ return x.id === id; });
  var wasPinned = t ? !!t.pinned : false;
  if(t) t.pinned = !wasPinned;
  renderMaintenanceBoard();
  apiSend('/api/maintenance/' + encodeURIComponent(id) + '/pin', 'POST', {}).then(function(res){
    var idx = STATE.tickets.findIndex(function(x){ return x.id === id; });
    if(idx !== -1) STATE.tickets[idx] = res.ticket;
    renderMaintenanceBoard();
  }).catch(function(){
    if(t) t.pinned = wasPinned;
    renderMaintenanceBoard();
    showToast("Couldn't update pin");
  });
}

var MAINT_STATUS_LABEL = { reported: "Reported", in_progress: "In progress", fixed: "Fixed" };
function isTicketVideo(t){
  return !!(t.photoUrl && /\.(mp4|webm|mov|m4v|3gp)($|\?)/i.test(t.photoUrl));
}
function buildStatusActions(t, onAfterUpdate){
  var actions = document.createElement("div");
  actions.className = "maint-card-actions";
  if(STATE.self !== "maintenance" && !(AUTH.staff && AUTH.staff.isAdmin)) return actions;
  function go(status){
    updateTicketStatus(t.id, status);
    if(onAfterUpdate) onAfterUpdate();
  }
  if(t.status === "reported"){
    var startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "maint-card-btn primary";
    startBtn.textContent = "Start work";
    startBtn.addEventListener("click", function(e){ e.stopPropagation(); go("in_progress"); });
    actions.appendChild(startBtn);
  } else if(t.status === "in_progress"){
    var backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "maint-card-btn";
    backBtn.textContent = "Back to reported";
    backBtn.addEventListener("click", function(e){ e.stopPropagation(); go("reported"); });
    actions.appendChild(backBtn);
    var fixedBtn = document.createElement("button");
    fixedBtn.type = "button";
    fixedBtn.className = "maint-card-btn fixed-btn";
    fixedBtn.textContent = "Mark fixed";
    fixedBtn.addEventListener("click", function(e){ e.stopPropagation(); go("fixed"); });
    actions.appendChild(fixedBtn);
  } else {
    var reopenBtn = document.createElement("button");
    reopenBtn.type = "button";
    reopenBtn.className = "maint-card-btn";
    reopenBtn.textContent = "Reopen";
    reopenBtn.addEventListener("click", function(e){ e.stopPropagation(); go("in_progress"); });
    actions.appendChild(reopenBtn);
  }
  return actions;
}
var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M8 3h8l-1 7 3 3H6l3-3-1-7z"/></svg>';
function buildPinButton(t){
  var pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "maint-pin-btn" + (t.pinned ? " pinned" : "");
  pinBtn.setAttribute("aria-label", t.pinned ? "Unpin job" : "Pin job");
  pinBtn.innerHTML = PIN_SVG;
  pinBtn.addEventListener("click", function(e){ e.stopPropagation(); togglePinTicket(t.id); });
  return pinBtn;
}
function reorderTickets(ids){
  ids.forEach(function(id, i){
    var t = STATE.tickets.find(function(x){ return x.id === id; });
    if(t) t.sortOrder = i * 10;
  });
  apiSend('/api/maintenance/reorder', 'POST', { order: ids }).then(function(res){
    (res.tickets || []).forEach(function(updated){
      var idx = STATE.tickets.findIndex(function(x){ return x.id === updated.id; });
      if(idx !== -1) STATE.tickets[idx] = updated;
    });
  }).catch(function(){
    showToast("Couldn't save that order");
  });
}
var MAINT_DRAG_HOLD_MS = 380;
var MAINT_DRAG_MOVE_CANCEL = 9;
function enableTicketDrag(card){
  var holdTimer = null, dragging = false, pointerId = null;
  var startX = 0, startY = 0;
  var cardEls = [], itemHeight = 0, draggedIndex = -1, targetIndex = -1;

  function cleanupTimer(){ if(holdTimer){ clearTimeout(holdTimer); holdTimer = null; } }

  function beginDrag(){
    dragging = true;
    card._wasDragged = true;
    card.classList.add("dragging");
    cardEls = Array.prototype.slice.call(maintFeed.children).filter(function(el){ return el.classList.contains("maint-card"); });
    draggedIndex = cardEls.indexOf(card);
    targetIndex = draggedIndex;
    itemHeight = card.getBoundingClientRect().height + 13;
    if(navigator.vibrate) navigator.vibrate(15);
    card.style.transition = "transform .14s cubic-bezier(.34,1.56,.64,1), box-shadow .14s ease";
    card.style.transform = "translateY(-7px) scale(1.06) rotate(-1.2deg)";
    setTimeout(function(){ if(dragging) card.style.transition = "none"; }, 150);
  }

  function applyShift(dy){
    if(itemHeight <= 0) return;
    var newIndex = Math.round(draggedIndex + dy / itemHeight);
    newIndex = Math.max(0, Math.min(cardEls.length - 1, newIndex));
    if(newIndex === targetIndex) return;
    cardEls.forEach(function(el, i){
      if(i === draggedIndex) return;
      var shift = 0;
      if(draggedIndex < newIndex && i > draggedIndex && i <= newIndex) shift = -itemHeight;
      else if(draggedIndex > newIndex && i >= newIndex && i < draggedIndex) shift = itemHeight;
      el.style.transform = shift ? "translateY(" + shift + "px)" : "";
    });
    targetIndex = newIndex;
  }

  function onPointerMove(e){
    if(pointerId === null || e.pointerId !== pointerId) return;
    var dx = e.clientX - startX, dy = e.clientY - startY;
    if(!dragging){
      if(Math.abs(dx) > MAINT_DRAG_MOVE_CANCEL || Math.abs(dy) > MAINT_DRAG_MOVE_CANCEL) cleanupTimer();
      return;
    }
    e.preventDefault();
    card.style.transform = "translateY(" + (dy - 7) + "px) scale(1.06) rotate(-1.2deg)";
    applyShift(dy);
  }

  function finishDrag(){
    if(dragging){
      cardEls.forEach(function(el){ el.style.transform = ""; });
      card.style.transition = "transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .2s ease";
      card.style.transform = "";
      card.classList.remove("dragging");
      setTimeout(function(){ card.style.transition = ""; }, 220);
      if(targetIndex !== draggedIndex){
        var reordered = cardEls.slice();
        reordered.splice(draggedIndex, 1);
        reordered.splice(targetIndex, 0, card);
        reordered.forEach(function(el){ maintFeed.appendChild(el); });
        reorderTickets(reordered.map(function(el){ return el.dataset.ticketId; }));
      }
      setTimeout(function(){ card._wasDragged = false; }, 50);
    }
    dragging = false;
    cleanupTimer();
    if(pointerId !== null){ try{ card.releasePointerCapture(pointerId); }catch(e){} }
    pointerId = null;
    card.removeEventListener("pointermove", onPointerMove);
    card.removeEventListener("pointerup", finishDrag);
    card.removeEventListener("pointercancel", finishDrag);
  }

  card.addEventListener("contextmenu", function(e){ e.preventDefault(); });
  card.addEventListener("pointerdown", function(e){
    if(e.button !== undefined && e.button !== 0) return;
    if(e.target.closest("button")) return;
    startX = e.clientX; startY = e.clientY;
    pointerId = e.pointerId;
    card.setPointerCapture(pointerId);
    card.addEventListener("pointermove", onPointerMove);
    card.addEventListener("pointerup", finishDrag);
    card.addEventListener("pointercancel", finishDrag);
    holdTimer = setTimeout(beginDrag, MAINT_DRAG_HOLD_MS);
  });
}
function buildMaintCard(t){
  var card = document.createElement("div");
  card.className = "maint-card status-" + t.status + (t.pinned ? " pinned" : "");
  card.dataset.ticketId = t.id;
  var isVideo = isTicketVideo(t);
  var top = document.createElement("div");
  top.className = "maint-card-top";
  if(t.photoUrl){
    var thumb = document.createElement(isVideo ? "video" : "img");
    thumb.className = "maint-card-thumb";
    thumb.src = t.photoUrl;
    if(isVideo){ thumb.muted = true; thumb.setAttribute("preload", "metadata"); }
    else thumb.alt = "Issue photo";
    top.appendChild(thumb);
  }
  var info = document.createElement("div");
  info.className = "maint-card-info";
  var infoHtml = "";
  if(t.roomNumber) infoHtml += '<span class="maint-card-room">' + esc(t.roomNumber) + '</span>';
  infoHtml += '<div class="maint-card-desc">' + esc(t.description) + '</div>';
  var tagsHtml = "";
  if(t.priority === "safety") tagsHtml += '<span class="maint-tag tag-safety">Safety</span>';
  else if(t.priority === "guest") tagsHtml += '<span class="maint-tag tag-guest">Guest impact</span>';
  else if(t.priority === "routine") tagsHtml += '<span class="maint-tag tag-routine">Routine</span>';
  if(t.guestPresent) tagsHtml += '<span class="maint-tag tag-present">Guest in room</span>';
  if(t.deadline) tagsHtml += '<span class="maint-tag ' + (isTicketOverdue(t) ? "tag-overdue" : "tag-deadline") + '">' + (isTicketOverdue(t) ? "Overdue " : "Due ") + fmtDeadline(t.deadline) + '</span>';
  if(tagsHtml) infoHtml += '<div class="maint-card-tags">' + tagsHtml + '</div>';
  infoHtml += '<div class="maint-card-meta">' + esc(DEPTS[t.createdBy] ? DEPTS[t.createdBy].name : t.createdBy) + ' · ' + fmtNoteTime(t.createdAt) + '</div>';
  info.innerHTML = infoHtml;
  top.appendChild(info);
  card.appendChild(top);
  card.appendChild(buildPinButton(t));
  card.appendChild(buildStatusActions(t));
  card.addEventListener("click", function(){
    if(card._wasDragged) return;
    openTicketDetail(t.id);
  });
  enableTicketDrag(card);
  return card;
}

/* ---- Ticket detail / one-by-one feed view ---- */
var ticketDetailOverlay = document.getElementById("ticketDetailOverlay");
var ticketDetailBody = document.getElementById("ticketDetailBody");
var ticketDetailClose = document.getElementById("ticketDetailClose");
var ticketDetailPrev = document.getElementById("ticketDetailPrev");
var ticketDetailNext = document.getElementById("ticketDetailNext");
var ticketDetailPos = document.getElementById("ticketDetailPos");
STATE.ticketDetailQueue = [];
STATE.ticketDetailIndex = -1;

function openTicketDetail(ticketId){
  var t = STATE.tickets.find(function(x){ return x.id === ticketId; });
  if(!t) return;
  STATE.ticketDetailQueue = sortedTickets().map(function(x){ return x.id; });
  STATE.ticketDetailIndex = STATE.ticketDetailQueue.indexOf(ticketId);
  ticketDetailOverlay.hidden = false;
  appToast.classList.add("above-modal");
  renderTicketDetail();
}
function closeTicketDetail(){
  ticketDetailOverlay.hidden = true;
  appToast.classList.remove("above-modal");
  STATE.ticketDetailQueue = [];
  STATE.ticketDetailIndex = -1;
}
function renderTicketDetail(){
  var id = STATE.ticketDetailQueue[STATE.ticketDetailIndex];
  var t = id && STATE.tickets.find(function(x){ return x.id === id; });
  if(!t){ closeTicketDetail(); return; }

  var html = '<div class="ticket-detail-status status-' + t.status + '">' + MAINT_STATUS_LABEL[t.status] + '</div>';
  var detailTagsHtml = "";
  if(t.priority === "safety") detailTagsHtml += '<span class="maint-tag tag-safety">Safety</span>';
  else if(t.priority === "guest") detailTagsHtml += '<span class="maint-tag tag-guest">Guest impact</span>';
  else if(t.priority === "routine") detailTagsHtml += '<span class="maint-tag tag-routine">Routine</span>';
  if(t.guestPresent) detailTagsHtml += '<span class="maint-tag tag-present">Guest in room</span>';
  if(t.deadline) detailTagsHtml += '<span class="maint-tag ' + (isTicketOverdue(t) ? "tag-overdue" : "tag-deadline") + '">' + (isTicketOverdue(t) ? "Overdue " : "Due ") + fmtDeadline(t.deadline) + '</span>';
  if(detailTagsHtml) html += '<div class="maint-card-tags ticket-detail-tags">' + detailTagsHtml + '</div>';
  if(t.roomNumber){
    html += '<div class="ticket-detail-room"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/></svg> ' + esc(t.roomNumber) + '</div>';
  }
  html += '<div class="ticket-detail-desc">' + esc(t.description) + '</div>';
  var isVideo = isTicketVideo(t);
  if(t.photoUrl && isVideo){
    html += '<video class="ticket-detail-media" src="' + t.photoUrl + '" controls playsinline></video>';
  } else if(t.photoUrl){
    html += '<img class="ticket-detail-media" src="' + t.photoUrl + '" alt="Issue photo">';
  }
  html += '<div class="ticket-detail-meta">Reported by ' + esc(DEPTS[t.createdBy] ? DEPTS[t.createdBy].name : t.createdBy) + ' · ' + fmtNoteTime(t.createdAt) + '</div>';
  ticketDetailBody.innerHTML = html;
  var pinBtn = buildPinButton(t);
  pinBtn.classList.add("ticket-detail-pin");
  ticketDetailBody.insertBefore(pinBtn, ticketDetailBody.firstChild);
  ticketDetailBody.appendChild(buildStatusActions(t, function(){
    STATE.ticketDetailQueue.splice(STATE.ticketDetailIndex, 1);
    if(!STATE.ticketDetailQueue.length){ closeTicketDetail(); return; }
    if(STATE.ticketDetailIndex >= STATE.ticketDetailQueue.length) STATE.ticketDetailIndex = STATE.ticketDetailQueue.length - 1;
    renderTicketDetail();
  }));

  var canDelete = (t.status === "reported" || AUTH.staff.isAdmin) && (t.createdBy === STATE.self || AUTH.staff.isAdmin);
  if(canDelete){
    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ticket-detail-delete";
    delBtn.textContent = "Delete this job";
    delBtn.addEventListener("click", function(){ deleteTicketFromDetail(t.id); });
    ticketDetailBody.appendChild(delBtn);
  }

  var repliesWrap = document.createElement("div");
  repliesWrap.className = "ticket-replies";
  repliesWrap.innerHTML = '<div class="ticket-replies-list" id="ticketRepliesList"><div class="ticket-replies-loading">Loading…</div></div>' +
    '<div class="ticket-reply-row"><input type="text" id="ticketReplyInput" placeholder="Reply about this job…" maxlength="500"><button type="button" id="ticketReplySendBtn">Send</button></div>';
  ticketDetailBody.appendChild(repliesWrap);
  loadAndRenderTicketReplies(t.id);
  document.getElementById("ticketReplySendBtn").addEventListener("click", function(){ sendTicketReply(t.id); });
  document.getElementById("ticketReplyInput").addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); sendTicketReply(t.id); } });

  ticketDetailPos.textContent = (STATE.ticketDetailIndex + 1) + " of " + STATE.ticketDetailQueue.length + " · " + MAINT_STATUS_LABEL[t.status];
  ticketDetailPrev.disabled = STATE.ticketDetailIndex <= 0;
  ticketDetailNext.disabled = STATE.ticketDetailIndex >= STATE.ticketDetailQueue.length - 1;
}
function renderTicketReplies(list){
  var el = document.getElementById("ticketRepliesList");
  if(!el) return;
  if(!list.length){ el.innerHTML = '<div class="ticket-replies-empty">No replies yet</div>'; return; }
  el.innerHTML = list.map(function(r){
    var name = DEPTS[r.from] ? DEPTS[r.from].name : r.from;
    return '<div class="ticket-reply"><div class="ticket-reply-head"><b>'+esc(name)+'</b><span>'+fmtClock(new Date(r.createdAt).getTime())+'</span></div><div class="ticket-reply-text">'+esc(r.text)+'</div></div>';
  }).join("");
  el.scrollTop = el.scrollHeight;
}
function loadAndRenderTicketReplies(ticketId){
  apiGet('/api/maintenance/' + encodeURIComponent(ticketId) + '/replies').then(function(res){
    STATE.ticketReplies = STATE.ticketReplies || {};
    STATE.ticketReplies[ticketId] = res.replies;
    if(STATE.ticketDetailQueue[STATE.ticketDetailIndex] === ticketId) renderTicketReplies(res.replies);
  }).catch(function(){});
}
function sendTicketReply(ticketId){
  var input = document.getElementById("ticketReplyInput");
  if(!input) return;
  var text = input.value.trim();
  if(!text) return;
  input.value = "";
  apiSend('/api/maintenance/' + encodeURIComponent(ticketId) + '/replies', 'POST', { text: text }).then(function(res){
    STATE.ticketReplies = STATE.ticketReplies || {};
    STATE.ticketReplies[ticketId] = STATE.ticketReplies[ticketId] || [];
    STATE.ticketReplies[ticketId].push(res.reply);
    if(STATE.ticketDetailQueue[STATE.ticketDetailIndex] === ticketId) renderTicketReplies(STATE.ticketReplies[ticketId]);
  }).catch(function(){ showToast("Couldn't send that"); });
}
ticketDetailClose.addEventListener("click", closeTicketDetail);
ticketDetailOverlay.addEventListener("click", function(e){ if(e.target === ticketDetailOverlay) closeTicketDetail(); });
ticketDetailPrev.addEventListener("click", function(){
  if(STATE.ticketDetailIndex > 0){ STATE.ticketDetailIndex -= 1; renderTicketDetail(); }
});
ticketDetailNext.addEventListener("click", function(){
  if(STATE.ticketDetailIndex < STATE.ticketDetailQueue.length - 1){ STATE.ticketDetailIndex += 1; renderTicketDetail(); }
});
function deleteTicketFromDetail(id){
  showConfirm({ title: "Delete this job?", body: "This can't be undone." }).then(function(ok){
    if(!ok) return;
    apiDelete('/api/maintenance/' + encodeURIComponent(id)).then(function(){
      STATE.tickets = STATE.tickets.filter(function(x){ return x.id !== id; });
      STATE.ticketDetailQueue.splice(STATE.ticketDetailIndex, 1);
      if(!STATE.ticketDetailQueue.length){ closeTicketDetail(); } else {
        if(STATE.ticketDetailIndex >= STATE.ticketDetailQueue.length) STATE.ticketDetailIndex = STATE.ticketDetailQueue.length - 1;
        renderTicketDetail();
      }
      renderMaintenanceBoard();
      showToast("Deleted");
    }).catch(function(err){
      showToast(err.message || "Couldn't delete that");
    });
  });
}

var tabMaintBadge = document.getElementById("tabMaintBadge");
function refreshMaintenanceBadge(){
  apiGet('/api/maintenance').then(function(res){
    STATE.tickets = res.tickets;
    var n = res.tickets.filter(function(t){ return t.status === "reported"; }).length;
    tabMaintBadge.hidden = n === 0;
    tabMaintBadge.textContent = n > 99 ? "99+" : String(n);
    if(!maintenancePage.hidden) renderMaintenanceBoard();
  }).catch(function(){});
}

function matchesSearch(term, fields){
  if(!term) return true;
  term = term.toLowerCase();
  return fields.some(function(f){ return f && String(f).toLowerCase().indexOf(term) !== -1; });
}

function renderMaintenanceBoard(){
  var term = STATE.maintSearchTerm || "";
  var all = sortedTickets().filter(function(t){
    return matchesSearch(term, [t.description, t.roomNumber, DEPTS[t.createdBy] ? DEPTS[t.createdBy].name : t.createdBy]);
  });
  var todoCount = all.filter(function(t){ return t.status !== "fixed"; }).length;
  var doneCount = all.filter(function(t){ return t.status === "fixed"; }).length;
  maintFilterRow.querySelector('[data-filter="todo"]').textContent = todoCount ? "To do (" + todoCount + ")" : "To do";
  maintFilterRow.querySelector('[data-filter="done"]').textContent = doneCount ? "Done (" + doneCount + ")" : "Done";

  var tickets = all.filter(function(t){
    return STATE.maintFilter === "done" ? t.status === "fixed" : t.status !== "fixed";
  });
  maintFeed.innerHTML = "";
  if(!tickets.length){
    var emptyMsg = term ? "No jobs match \""+esc(term)+"\"" : (STATE.maintFilter === "done" ? "No fixed jobs yet" : "No open maintenance jobs");
    maintFeed.innerHTML = '<div class="maint-col-empty">'+emptyMsg+'</div>';
    return;
  }
  tickets.forEach(function(t){ maintFeed.appendChild(buildMaintCard(t)); });
}

function updateTicketStatus(id, status){
  var t = STATE.tickets.find(function(x){ return x.id === id; });
  var prevStatus = t ? t.status : null;
  if(t) t.status = status;
  renderMaintenanceBoard();
  apiSend('/api/maintenance/' + encodeURIComponent(id) + '/status', 'POST', { status: status }).then(function(res){
    var idx = STATE.tickets.findIndex(function(x){ return x.id === id; });
    if(idx !== -1) STATE.tickets[idx] = res.ticket;
    renderMaintenanceBoard();
    showToast(MAINT_STATUS_LABEL[status]);
  }).catch(function(){
    if(t && prevStatus) t.status = prevStatus;
    renderMaintenanceBoard();
    showToast("Couldn't update that");
  });
}

/* ---- Guest concierge requests ---- */
var guestsFeed = document.getElementById("guestsFeed");
STATE.guestRequests = STATE.guestRequests || [];
var GUEST_STATUS_LABEL = { new: "New", in_progress: "In progress", completed: "Completed" };
var GUEST_STATUS_ORDER = { new: 0, in_progress: 1, completed: 2 };

function openGuestsTab(){
  guestsFeed.innerHTML = '<div class="maint-col-empty">Loading&hellip;</div>';
  refreshGuestsBadge();
}

var guestsSearchInput = document.getElementById("guestsSearchInput");
var guestsSearchClear = document.getElementById("guestsSearchClear");
STATE.guestsSearchTerm = "";
guestsSearchInput.addEventListener("input", function(){
  STATE.guestsSearchTerm = guestsSearchInput.value;
  guestsSearchClear.hidden = STATE.guestsSearchTerm.length === 0;
  renderGuestsBoard();
});
guestsSearchClear.addEventListener("click", function(){
  guestsSearchInput.value = "";
  STATE.guestsSearchTerm = "";
  guestsSearchClear.hidden = true;
  renderGuestsBoard();
  guestsSearchInput.focus();
});

function sortedGuestRequests(){
  return (STATE.guestRequests || []).slice().sort(function(a, b){
    if(!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if(GUEST_STATUS_ORDER[a.status] !== GUEST_STATUS_ORDER[b.status]) return GUEST_STATUS_ORDER[a.status] - GUEST_STATUS_ORDER[b.status];
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function refreshGuestsBadge(){
  apiGet('/api/guest-requests').then(function(res){
    STATE.guestRequests = res.requests;
    var n = res.requests.filter(function(r){ return r.status !== "completed"; }).length;
    tabGuestsBadge.hidden = n === 0;
    tabGuestsBadge.textContent = n > 99 ? "99+" : String(n);
    if(!guestsPage.hidden) renderGuestsBoard();
  }).catch(function(){});
}

function renderGuestsBoard(){
  var term = STATE.guestsSearchTerm || "";
  var requests = sortedGuestRequests().filter(function(r){
    return matchesSearch(term, [r.text, r.roomNumber]);
  });
  guestsFeed.innerHTML = "";
  if(!requests.length){
    guestsFeed.innerHTML = '<div class="maint-col-empty">'+(term ? "No requests match \""+esc(term)+"\"" : "No guest requests yet")+'</div>';
    return;
  }
  requests.forEach(function(r){ guestsFeed.appendChild(buildGuestCard(r)); });
}

function toggleGuestRequestPin(id){
  var r = STATE.guestRequests.find(function(x){ return x.id === id; });
  var wasPinned = r ? !!r.pinned : false;
  if(r) r.pinned = !wasPinned;
  renderGuestsBoard();
  apiSend('/api/guest-requests/' + encodeURIComponent(id) + '/pin', 'POST', {}).then(function(res){
    var idx = STATE.guestRequests.findIndex(function(x){ return x.id === id; });
    if(idx !== -1) STATE.guestRequests[idx] = res.request;
    renderGuestsBoard();
  }).catch(function(){
    if(r) r.pinned = wasPinned;
    renderGuestsBoard();
    showToast("Couldn't update pin");
  });
}

function updateGuestRequestStatus(id, status, replyText){
  var r = STATE.guestRequests.find(function(x){ return x.id === id; });
  var prevStatus = r ? r.status : null;
  if(r) r.status = status;
  renderGuestsBoard();
  var payload = { status: status };
  if(replyText !== undefined) payload.replyText = replyText;
  apiSend('/api/guest-requests/' + encodeURIComponent(id) + '/status', 'POST', payload).then(function(res){
    var idx = STATE.guestRequests.findIndex(function(x){ return x.id === id; });
    if(idx !== -1) STATE.guestRequests[idx] = res.request;
    renderGuestsBoard();
    refreshGuestsBadge();
    showToast(GUEST_STATUS_LABEL[status]);
  }).catch(function(){
    if(r && prevStatus) r.status = prevStatus;
    renderGuestsBoard();
    showToast("Couldn't update that");
  });
}

function buildGuestCard(r){
  var card = document.createElement("div");
  card.className = "guest-card status-" + r.status + (r.pinned ? " pinned" : "");

  var pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "guest-pin-btn" + (r.pinned ? " pinned" : "");
  pinBtn.setAttribute("aria-label", r.pinned ? "Unpin request" : "Pin request");
  pinBtn.innerHTML = PIN_SVG;
  pinBtn.addEventListener("click", function(){ toggleGuestRequestPin(r.id); });
  card.appendChild(pinBtn);

  var head = document.createElement("div");
  head.className = "guest-card-head";
  head.innerHTML = '<span class="guest-card-room">' + esc(r.roomNumber) + '</span>' +
    '<span class="guest-status-pill status-' + r.status + '">' + GUEST_STATUS_LABEL[r.status] + '</span>';
  card.appendChild(head);

  var desc = document.createElement("div");
  desc.className = "guest-card-desc";
  desc.textContent = "“" + r.text + "”";
  card.appendChild(desc);

  var meta = document.createElement("div");
  meta.className = "guest-card-meta";
  meta.textContent = (r.status === "completed" ? "Completed " : "Requested ") + fmtNoteTime(r.status === "completed" ? r.completedAt : r.createdAt);
  card.appendChild(meta);

  if(r.status === "new"){
    var startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "guest-card-btn primary";
    startBtn.textContent = "Start on it";
    startBtn.addEventListener("click", function(){ updateGuestRequestStatus(r.id, "in_progress"); });
    var row = document.createElement("div");
    row.className = "guest-card-actions";
    row.appendChild(startBtn);
    card.appendChild(row);
  } else if(r.status === "in_progress"){
    var noteWrap = document.createElement("div");
    noteWrap.className = "guest-reply-box";
    noteWrap.innerHTML = '<div class="guest-reply-label">Note back to guest (optional)</div>' +
      '<input type="text" class="guest-reply-input" placeholder="e.g. “On its way up now, congratulations!”" maxlength="300">';
    card.appendChild(noteWrap);
    var replyInput = noteWrap.querySelector(".guest-reply-input");

    var row2 = document.createElement("div");
    row2.className = "guest-card-actions";
    var backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "guest-card-btn";
    backBtn.textContent = "Back to new";
    backBtn.addEventListener("click", function(){ updateGuestRequestStatus(r.id, "new"); });
    row2.appendChild(backBtn);
    var completeBtn = document.createElement("button");
    completeBtn.type = "button";
    completeBtn.className = "guest-card-btn complete-btn";
    completeBtn.textContent = "Mark complete";
    completeBtn.addEventListener("click", function(){ updateGuestRequestStatus(r.id, "completed", replyInput.value.trim()); });
    row2.appendChild(completeBtn);
    card.appendChild(row2);
  } else {
    if(r.replyText){
      var replyBox = document.createElement("div");
      replyBox.className = "guest-reply-box";
      replyBox.innerHTML = '<div class="guest-reply-label">Your reply</div>' +
        '<div class="guest-reply-text">“' + esc(r.replyText) + '”</div>';
      card.appendChild(replyBox);
    }
  }

  return card;
}

newMaintPhoto.addEventListener("change", function(){
  var file = newMaintPhoto.files && newMaintPhoto.files[0];
  if(!file) return;
  maintPhotoFile = file;
  var isVideo = file.type.indexOf("video/") === 0;
  var reader = new FileReader();
  reader.onload = function(){
    if(isVideo){
      maintPhotoPreviewVideo.src = String(reader.result);
      maintPhotoPreviewVideo.hidden = false;
      maintPhotoPreviewImg.hidden = true;
    } else {
      maintPhotoPreviewImg.src = String(reader.result);
      maintPhotoPreviewImg.hidden = false;
      maintPhotoPreviewVideo.hidden = true;
    }
    maintPhotoPreview.hidden = false;
  };
  reader.readAsDataURL(file);
});
maintPhotoRemove.addEventListener("click", function(){
  maintPhotoFile = null;
  newMaintPhoto.value = "";
  maintPhotoPreview.hidden = true;
  maintPhotoPreviewVideo.src = "";
});

newMaintForm.addEventListener("submit", function(e){
  e.preventDefault();
  maintError.textContent = "";
  var description = newMaintDesc.value.trim();
  if(!description) return;
  var payload = {
    description: description,
    roomNumber: newMaintRoom.value.trim() || undefined,
    priority: maintSelectedPriority,
    guestPresent: newMaintGuestPresent.checked,
    deadline: newMaintDeadline.value || undefined,
  };
  var submitBtn = newMaintForm.querySelector(".admin-add-btn");
  submitBtn.disabled = true;
  var sendPromise = maintPhotoFile
    ? blobToBase64(maintPhotoFile).then(function(b64){
        payload.photoBase64 = b64;
        payload.photoMime = maintPhotoFile.type;
        return apiSend('/api/maintenance', 'POST', payload);
      })
    : apiSend('/api/maintenance', 'POST', payload);
  sendPromise.then(function(res){
    if(res.merged){
      var existingIdx = STATE.tickets.findIndex(function(x){ return x.id === res.ticket.id; });
      if(existingIdx !== -1) STATE.tickets[existingIdx] = res.ticket; else STATE.tickets.unshift(res.ticket);
    } else {
      STATE.tickets.unshift(res.ticket);
    }
    renderMaintenanceBoard();
    newMaintDesc.value = "";
    newMaintRoom.value = "";
    maintPhotoFile = null;
    newMaintPhoto.value = "";
    maintPhotoPreview.hidden = true;
    maintPhotoPreviewVideo.src = "";
    newMaintGuestPresent.checked = false;
    newMaintDeadline.value = "";
    maintSelectedPriority = "problem";
    maintPriorityChips.forEach(function(c){ c.classList.toggle("active", c.getAttribute("data-priority") === "problem"); });
    showToast(res.merged ? "Already reported. Added your note to it" : (isOnDuty("maintenance") ? "Reported" : "Reported. Maintenance is off duty, they'll see it once they're back on"));
  }).catch(function(err){
    maintError.textContent = err.message || "Couldn't report that issue.";
  }).finally(function(){ submitBtn.disabled = false; });
});

/* ---- Hotel asset exchange (reached via the composer's "Item request"
   option and Profile > More options > Asset exchange - not a main tab) ---- */
var assetFeed = document.getElementById("assetFeed");
var newAssetForm = document.getElementById("newAssetForm");
var newAssetItem = document.getElementById("newAssetItem");
var newAssetNotes = document.getElementById("newAssetNotes");
var assetError = document.getElementById("assetError");
STATE.assetRequests = STATE.assetRequests || [];
var ASSET_STATUS_LABEL = { requested: "Requested", borrowed: "Borrowed", returned: "Returned" };
var ASSET_STATUS_ORDER = { requested: 0, borrowed: 1, returned: 2 };
var ASSET_NEXT_STATUS = { requested: "borrowed", borrowed: "returned" };
var ASSET_NEXT_LABEL = { requested: "Mark borrowed", borrowed: "Mark returned" };

var assetsOverlay = document.getElementById("assetsOverlay");
var assetsClose = document.getElementById("assetsClose");
var assetsBtn = document.getElementById("assetsBtn");
function refreshAssetsList(){
  apiGet('/api/assets').then(function(res){
    STATE.assetRequests = res.requests;
    if(!assetsOverlay.hidden) renderAssetsBoard();
  }).catch(function(){});
}
function openAssetsOverlay(focusForm){
  assetsOverlay.hidden = false;
  assetFeed.innerHTML = '<div class="maint-col-empty">Loading&hellip;</div>';
  refreshAssetsList();
  if(focusForm) setTimeout(function(){ newAssetItem.focus(); }, 30);
}
assetsClose.addEventListener("click", function(){ assetsOverlay.hidden = true; });
assetsOverlay.addEventListener("click", function(e){ if(e.target === assetsOverlay) assetsOverlay.hidden = true; });
assetsBtn.addEventListener("click", function(){ openAssetsOverlay(false); });

var assetSearchInput = document.getElementById("assetSearchInput");
var assetSearchClear = document.getElementById("assetSearchClear");
STATE.assetSearchTerm = "";
assetSearchInput.addEventListener("input", function(){
  STATE.assetSearchTerm = assetSearchInput.value;
  assetSearchClear.hidden = STATE.assetSearchTerm.length === 0;
  renderAssetsBoard();
});
assetSearchClear.addEventListener("click", function(){
  assetSearchInput.value = "";
  STATE.assetSearchTerm = "";
  assetSearchClear.hidden = true;
  renderAssetsBoard();
  assetSearchInput.focus();
});

function sortedAssetRequests(){
  return (STATE.assetRequests || []).slice().sort(function(a, b){
    if(ASSET_STATUS_ORDER[a.status] !== ASSET_STATUS_ORDER[b.status]) return ASSET_STATUS_ORDER[a.status] - ASSET_STATUS_ORDER[b.status];
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function renderAssetsBoard(){
  var term = STATE.assetSearchTerm || "";
  var requests = sortedAssetRequests().filter(function(r){
    return matchesSearch(term, [r.itemName, r.notes, DEPTS[r.requestedBy] ? DEPTS[r.requestedBy].name : r.requestedBy]);
  });
  assetFeed.innerHTML = "";
  if(!requests.length){
    assetFeed.innerHTML = '<div class="maint-col-empty">'+(term ? "No requests match \""+esc(term)+"\"" : "No asset requests yet")+'</div>';
    return;
  }
  requests.forEach(function(r){ assetFeed.appendChild(buildAssetCard(r)); });
}

function updateAssetStatus(id, status){
  var r = STATE.assetRequests.find(function(x){ return x.id === id; });
  var prevStatus = r ? r.status : null;
  if(r) r.status = status;
  renderAssetsBoard();
  apiSend('/api/assets/' + encodeURIComponent(id) + '/status', 'POST', { status: status }).then(function(res){
    var idx = STATE.assetRequests.findIndex(function(x){ return x.id === id; });
    if(idx !== -1) STATE.assetRequests[idx] = res.request;
    renderAssetsBoard();
    showToast(ASSET_STATUS_LABEL[status]);
  }).catch(function(){
    if(r && prevStatus) r.status = prevStatus;
    renderAssetsBoard();
    showToast("Couldn't update that");
  });
}

function deleteAssetRequest(id){
  showConfirm({ title: "Remove this request?", confirmLabel: "Remove" }).then(function(ok){
    if(!ok) return;
    apiDelete('/api/assets/' + encodeURIComponent(id)).then(function(){
      STATE.assetRequests = STATE.assetRequests.filter(function(x){ return x.id !== id; });
      renderAssetsBoard();
    }).catch(function(err){
      showToast(err.message || "Couldn't remove that");
    });
  });
}

function buildAssetCard(r){
  var card = document.createElement("div");
  card.className = "asset-card status-" + r.status;

  var top = document.createElement("div");
  top.className = "asset-card-top";
  top.innerHTML = '<span class="asset-card-item">' + esc(r.itemName) + '</span>' +
    '<span class="asset-status-pill ' + r.status + '">' + ASSET_STATUS_LABEL[r.status] + '</span>';
  card.appendChild(top);

  if(r.notes){
    var notes = document.createElement("div");
    notes.className = "asset-card-notes";
    notes.textContent = r.notes;
    card.appendChild(notes);
  }

  var meta = document.createElement("div");
  meta.className = "asset-card-meta";
  var deptName = DEPTS[r.requestedBy] ? DEPTS[r.requestedBy].name : r.requestedBy;
  meta.textContent = deptName + " · " + (r.status === "returned" ? "Returned " + fmtNoteTime(r.returnedAt) : "Requested " + fmtNoteTime(r.createdAt));
  card.appendChild(meta);

  var actions = document.createElement("div");
  actions.className = "asset-card-actions";
  var isMine = AUTH.staff && (r.requestedBy === STATE.self || AUTH.staff.isAdmin);
  if(ASSET_NEXT_STATUS[r.status] && isMine){
    var nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "asset-card-btn primary";
    nextBtn.textContent = ASSET_NEXT_LABEL[r.status];
    nextBtn.addEventListener("click", function(){ updateAssetStatus(r.id, ASSET_NEXT_STATUS[r.status]); });
    actions.appendChild(nextBtn);
  }
  if(isMine){
    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "asset-card-btn danger";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", function(){ deleteAssetRequest(r.id); });
    actions.appendChild(delBtn);
  }
  if(actions.childNodes.length) card.appendChild(actions);

  return card;
}

newAssetForm.addEventListener("submit", function(e){
  e.preventDefault();
  assetError.textContent = "";
  var itemName = newAssetItem.value.trim();
  if(!itemName) return;
  var payload = { itemName: itemName, notes: newAssetNotes.value.trim() || undefined };
  var submitBtn = newAssetForm.querySelector(".admin-add-btn");
  submitBtn.disabled = true;
  apiSend('/api/assets', 'POST', payload).then(function(res){
    STATE.assetRequests.unshift(res.request);
    renderAssetsBoard();
    newAssetItem.value = "";
    newAssetNotes.value = "";
    showToast("Requested");
  }).catch(function(err){
    assetError.textContent = err.message || "Couldn't send that request.";
  }).finally(function(){ submitBtn.disabled = false; });
});

/* ---- Requests (HOD sign-off) main-menu tab ---- */
var requestsFeed = document.getElementById("requestsFeed");
var newRequestForm = document.getElementById("newRequestForm");
var newRequestTitle = document.getElementById("newRequestTitle");
var newRequestAmount = document.getElementById("newRequestAmount");
var newRequestTo = document.getElementById("newRequestTo");
var newRequestCategory = document.getElementById("newRequestCategory");
var newRequestTarget = document.getElementById("newRequestTarget");
var newRequestGuest = document.getElementById("newRequestGuest");
var requestError = document.getElementById("requestError");
var tabRequestsBadge = document.getElementById("tabRequestsBadge");
STATE.signoffs = STATE.signoffs || [];

function populateRequestToOptions(){
  var prev = newRequestTo.value;
  newRequestTo.innerHTML = "";
  DEPT_ORDER.forEach(function(id){
    if(id === STATE.self) return;
    var opt = document.createElement("option");
    opt.value = id;
    opt.textContent = DEPTS[id] ? DEPTS[id].name : id;
    newRequestTo.appendChild(opt);
  });
  if(prev && DEPT_ORDER.indexOf(prev) !== -1 && prev !== STATE.self) newRequestTo.value = prev;
  else if(STATE.self !== "gm" && DEPT_ORDER.indexOf("gm") !== -1) newRequestTo.value = "gm";
}

function refreshRequestsBadge(){
  apiGet('/api/signoffs').then(function(res){
    STATE.signoffs = res.items;
    var n = res.items.filter(function(m){ return m.signoff && m.signoff.status === "pending" && m.to === STATE.self; }).length;
    tabRequestsBadge.hidden = n === 0;
    tabRequestsBadge.textContent = n > 99 ? "99+" : String(n);
    if(!requestsPage.hidden) renderRequestsBoard();
  }).catch(function(){});
}

function openRequestsTab(){
  populateRequestToOptions();
  requestsFeed.innerHTML = '<div class="maint-col-empty">Loading&hellip;</div>';
  refreshRequestsBadge();
}

function renderRequestsBoard(){
  requestsFeed.innerHTML = "";
  var items = (STATE.signoffs || []).slice().sort(function(a, b){
    if(!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return 0;
  });
  if(!items.length){
    requestsFeed.innerHTML = '<div class="maint-col-empty">No requests yet</div>';
    return;
  }
  items.forEach(function(m){ requestsFeed.appendChild(buildRequestCard(m)); });
}

function toggleRequestPin(m){
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/pin', 'POST', {}).then(function(res){
    var idx = STATE.signoffs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) STATE.signoffs[idx] = res.message;
    renderRequestsBoard();
    showToast(res.message.pinned ? "Pinned to top" : "Unpinned");
  }).catch(function(){ showToast("Couldn't update pin"); });
}

function decideRequestCard(m, decision, btn){
  btn.disabled = true;
  apiSend('/api/messages/' + encodeURIComponent(m.id) + '/signoff-decision', 'POST', { decision: decision }).then(function(res){
    var idx = STATE.signoffs.findIndex(function(x){ return x.id === m.id; });
    if(idx !== -1) STATE.signoffs[idx] = res.message;
    renderRequestsBoard();
    showToast(decision === "approved" ? "Approved" : "Declined");
    pollMissed();
  }).catch(function(){
    showToast("Couldn't record that decision");
    btn.disabled = false;
  });
}

function buildRequestCard(m){
  var s = m.signoff;
  var mine = m.from === STATE.self;
  var otherDept = mine ? m.to : m.from;
  var otherName = DEPTS[otherDept] ? DEPTS[otherDept].name : otherDept;
  var card = document.createElement("div");
  card.className = "missed-msg-card request-card" + (m.pinned ? " pinned" : "");
  var statusHtml;
  if(s.status === "pending" && !mine){
    statusHtml = '<div class="missed-approval-actions">' +
      '<button type="button" class="missed-approval-decline">Decline</button>' +
      '<button type="button" class="missed-approval-approve">Approve</button>' +
    '</div>';
  } else if(s.status === "pending"){
    statusHtml = '<div class="missed-msg-time">Awaiting sign-off from ' + esc(otherName) + '</div>';
  } else {
    var byName = s.decidedBy || "";
    statusHtml = '<div class="missed-msg-time">' + (s.status === "approved" ? "Approved" : "Declined") + (byName ? " by " + esc(byName) : "") + (s.decidedAt ? " · " + fmtNoteTime(s.decidedAt) : "") + '</div>';
  }
  var metaBits = [];
  if(s.category) metaBits.push(esc(s.category));
  if(s.target) metaBits.push(esc(s.target));
  if(s.guestInfo) metaBits.push(esc(s.guestInfo));
  card.innerHTML =
    '<span class="missed-msg-avatar" style="' + avatarStyleAttr(otherDept) + '">' + avatarInnerHtml(otherDept) + '</span>' +
    '<div class="missed-msg-body">' +
      (s.amount != null ? '<div class="request-amount-hero">' + esc(fmtSignoffAmount(s.amount)) + '</div>' : '') +
      '<div class="missed-msg-top">' +
        (s.code ? '<span class="request-code-badge">' + esc(s.code) + '</span>' : '') +
        '<span class="missed-msg-from">' + (mine ? "To " + esc(otherName) : "From " + esc(otherName)) + '</span>' +
      '</div>' +
      '<div class="missed-msg-preview">' + esc(s.title) + '</div>' +
      (metaBits.length ? '<div class="request-card-meta">' + metaBits.join(' · ') + '</div>' : '') +
      statusHtml +
    '</div>';
  if(s.status === "pending" && !mine){
    card.querySelector(".missed-approval-approve").addEventListener("click", function(e){ decideRequestCard(m, "approved", e.target); });
    card.querySelector(".missed-approval-decline").addEventListener("click", function(e){ decideRequestCard(m, "declined", e.target); });
  }
  card.querySelector(".missed-msg-body").addEventListener("click", function(e){
    if(e.target.closest(".missed-approval-actions")) return;
    showTab("chat");
    openThread(otherDept);
  });
  var pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "request-pin-btn" + (m.pinned ? " pinned" : "");
  pinBtn.setAttribute("aria-label", m.pinned ? "Unpin request" : "Pin request to top");
  pinBtn.title = m.pinned ? "Unpin" : "Pin to top";
  pinBtn.innerHTML = PIN_SVG;
  pinBtn.addEventListener("click", function(e){ e.stopPropagation(); toggleRequestPin(m); });
  card.appendChild(pinBtn);
  return card;
}

newRequestForm.addEventListener("submit", function(e){
  e.preventDefault();
  requestError.textContent = "";
  var title = newRequestTitle.value.trim();
  if(!title) return;
  var to = newRequestTo.value;
  if(!to){ requestError.textContent = "Choose who to send this to."; return; }
  var amountRaw = newRequestAmount.value.trim();
  var payload = {
    from: STATE.self, to: to, type: "text",
    text: "Requesting approval: " + title,
    signoff: {
      title: title,
      amount: amountRaw ? Number(amountRaw) : undefined,
      category: newRequestCategory.value || undefined,
      target: newRequestTarget.value.trim() || undefined,
      guestInfo: newRequestGuest.value.trim() || undefined,
    }
  };
  var submitBtn = newRequestForm.querySelector(".admin-add-btn");
  submitBtn.disabled = true;
  apiSend('/api/messages', 'POST', payload).then(function(res){
    STATE.signoffs.unshift(res.message);
    renderRequestsBoard();
    newRequestForm.reset();
    populateRequestToOptions();
    var code = res.message.signoff && res.message.signoff.code;
    showToast((code ? code + " sent to " : "Sent to ") + (DEPTS[to] ? DEPTS[to].name : to));
  }).catch(function(err){
    requestError.textContent = err.message || "Couldn't send that request.";
  }).finally(function(){ submitBtn.disabled = false; });
});

/* ---- Group thread view ---- */
function markGroupRead(groupId){
  apiSend('/api/groups/' + encodeURIComponent(groupId) + '/read', 'POST', { self: STATE.self }).catch(function(){});
}

function openGroupThread(groupId){
  var g = STATE.groups.find(function(x){ return x.id === groupId; });
  if(!g) return;
  clearReplyBar();
  clearEditBar();
  mentionPopover.hidden = true;
  saveCurrentDraft();
  STATE.active = null;
  STATE.activeGroupId = groupId;
  loadDraftInto(null, groupId);
  updateComposerLock();
  renderHeader();
  renderThread();
  document.getElementById("sidebar").classList.add("hide-mobile");
  document.querySelector(".main").classList.add("show-mobile");
  focusInput();
  if(window.innerWidth <= 720 && !(history.state && history.state.dashThread)){
    history.pushState({ dashThread: true }, "");
  }
  threadScroll.innerHTML = '<div class="handover-empty">Loading…</div>';
  apiGet('/api/groups/' + encodeURIComponent(groupId) + '/messages?self=' + encodeURIComponent(STATE.self)).then(function(res){
    STATE.groupMessages[groupId] = res.messages.map(function(row){ return mapServerMessage(row, STATE.self); });
    if(STATE.activeGroupId === groupId){ renderThread(); markGroupRead(groupId); }
  }).catch(function(){
    if(STATE.activeGroupId === groupId) threadScroll.innerHTML = '<div class="handover-empty">Couldn\'t load messages.</div>';
  });
}

function pollGroupsQuiet(){
  if(document.hidden || !AUTH.staff) return;
  loadGroups().then(function(){
    if(!eventsPage.hidden) renderEventList();
    var groupId = STATE.activeGroupId;
    if(!groupId) return;
    apiGet('/api/groups/' + encodeURIComponent(groupId) + '/messages?self=' + encodeURIComponent(STATE.self)).then(function(res){
      var mapped = res.messages.map(function(row){ return mapServerMessage(row, STATE.self); });
      var existing = STATE.groupMessages[groupId] || [];
      if(mapped.length !== existing.length || messagesChangeSignature(existing) !== messagesChangeSignature(mapped)){
        STATE.groupMessages[groupId] = mapped;
        if(STATE.activeGroupId === groupId){
          renderThread();
          markGroupRead(groupId);
        }
      }
    }).catch(function(){});
  });
}
var groupsPollTimer = setInterval(pollGroupsQuiet, 1500);

if("serviceWorker" in navigator){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("/sw.js").catch(function(){});
  });
}

/* ---------------- Push notifications ---------------- */
var pushPrompt = document.getElementById("pushPrompt");
var pushEnableBtn = document.getElementById("pushEnableBtn");
var pushDismissBtn = document.getElementById("pushDismissBtn");
var installPrompt = document.getElementById("installPrompt");
var installDismissBtn = document.getElementById("installDismissBtn");
var PUSH_DISMISS_KEY = "mdash_push_dismissed";

function urlBase64ToUint8Array(base64String){
  var padding = "=".repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var raw = atob(base64);
  var out = new Uint8Array(raw.length);
  for(var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported(){
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIOS(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone(){
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

var INSTALL_DISMISS_KEY = "mdash_install_dismissed";

function checkPushPrompt(){
  if(isIOS() && !isStandalone()){
    var installDismissed;
    try{ installDismissed = localStorage.getItem(INSTALL_DISMISS_KEY); }catch(e){ installDismissed = null; }
    if(!installDismissed) installPrompt.hidden = false;
    return;
  }
  if(!pushSupported()) return;
  if(Notification.permission === "denied") return;
  var dismissed;
  try{ dismissed = localStorage.getItem(PUSH_DISMISS_KEY); }catch(e){ dismissed = null; }
  if(dismissed) return;
  navigator.serviceWorker.ready.then(function(reg){
    return reg.pushManager.getSubscription();
  }).then(function(sub){
    if(!sub) pushPrompt.hidden = false;
  }).catch(function(){});
}

function subscribeToPush(){
  return apiGet('/api/push/vapid-public-key').then(function(res){
    return navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(res.key)
      });
    });
  }).then(function(sub){
    return apiSend('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
  });
}

if(pushEnableBtn){
  pushEnableBtn.addEventListener("click", function(){
    pushEnableBtn.disabled = true;
    Notification.requestPermission().then(function(perm){
      if(perm !== "granted"){ pushPrompt.hidden = true; return; }
      return subscribeToPush().then(function(){
        pushPrompt.hidden = true;
      });
    }).catch(function(){
      pushPrompt.hidden = true;
    }).finally(function(){ pushEnableBtn.disabled = false; });
  });
}

if(pushDismissBtn){
  pushDismissBtn.addEventListener("click", function(){
    pushPrompt.hidden = true;
    try{ localStorage.setItem(PUSH_DISMISS_KEY, "1"); }catch(e){}
  });
}

if(installDismissBtn){
  installDismissBtn.addEventListener("click", function(){
    installPrompt.hidden = true;
    try{ localStorage.setItem(INSTALL_DISMISS_KEY, "1"); }catch(e){}
  });
}

})();
