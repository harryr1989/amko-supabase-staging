// === AMKO Supabase KV sync (v2, resilient) ===
// - Defines AMKO_BOOT early so app code always runs.
// - If Supabase/config missing, runs in LOCAL mode (no remote writes) but app still works.
// - When available, hydrates KV into localStorage and patches setItem/removeItem to upsert/delete remotely.

// AMKO_BOOT is a small helper to ensure hydrate (if available) before app logic runs.
window.AMKO_BOOT = window.AMKO_BOOT || (async function(run){
  try { if (window.AMKO_KV?.hydrate) await window.AMKO_KV.hydrate(); }
  catch (e) { console.warn("[AMKO_BOOT] hydrate skipped:", e); }
  return run && run();
});

(function(){
  let hasSupabase = !!(window.supabase && window.AMKO_SUPA && window.AMKO_SUPA.url && window.AMKO_SUPA.anonKey);
  let client = null;
  const TABLE = "amko_kv";
  const SYNC_PREFIXES = ["amko.", "akun", "transMini", "transaksi", "trx", "mutasi"];

  function shouldSyncKey(k){
    if (!k || typeof k !== "string") return false;
    return SYNC_PREFIXES.some(p => k.startsWith(p));
  }

  // Preserve originals
  const _set = Storage.prototype.setItem;
  const _rm  = Storage.prototype.removeItem;

  let _hydrating = false;
  let _queue = [];
  let _flushTimer = null;

  async function upsertKV(key, rawStr){
    if (!hasSupabase || !client) return;
    let jsonVal;
    try { jsonVal = JSON.parse(rawStr); }
    catch(e){ jsonVal = rawStr; }
    return client.from(TABLE).upsert(
      { key, value: jsonVal, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  }

  async function deleteKV(key){
    if (!hasSupabase || !client) return;
    return client.from(TABLE).delete().eq("key", key);
  }

  function enqueue(op){
    if (!hasSupabase || !client) return; // local-only mode: skip remote queue
    _queue.push(op);
    if (_flushTimer) return;
    _flushTimer = setTimeout(flush, 150);
  }

  async function flush(){
    clearTimeout(_flushTimer); _flushTimer = null;
    const ops = _queue.splice(0, _queue.length);
    for (const op of ops){
      try{
        if (op.type === "set") await upsertKV(op.key, op.value);
        if (op.type === "del") await deleteKV(op.key);
      }catch(e){
        console.warn("[AMKO_KV] Sync op failed:", op, e);
      }
    }
  }

  async function hydrate(){
    _hydrating = true;
    try{
      if (!hasSupabase) return;
      const orParts = SYNC_PREFIXES.map(p => `key.ilike.${p.replaceAll('.','\\.')}%`);
      const orFilter = orParts.join(",");
      const { data, error } = await client.from(TABLE).select("key,value").or(orFilter);
      if (error) { console.warn("[AMKO_KV] hydrate error:", error.message); }
      else if (Array.isArray(data)){
        for (const row of data){
          try {
            const str = (typeof row.value === "string") ? row.value : JSON.stringify(row.value);
            _set.call(localStorage, row.key, str);
          } catch(e){ /* ignore */ }
        }
      }
    } finally {
      _hydrating = false;
    }
  }

  // Try to create Supabase client safely
  try{
    if (hasSupabase) client = window.supabase.createClient(window.AMKO_SUPA.url, window.AMKO_SUPA.anonKey);
  }catch(e){
    console.warn("[AMKO_KV] createClient failed, falling back to LOCAL mode:", e);
    hasSupabase = false;
  }

  // Patch localStorage regardless; in LOCAL mode only local writes happen.
  Storage.prototype.setItem = function(key, val){
    _set.call(this, key, val);
    if(!_hydrating && shouldSyncKey(key)){
      enqueue({type:"set", key, value: String(val)});
    }
  };
  Storage.prototype.removeItem = function(key){
    _rm.call(this, key);
    if(!_hydrating && shouldSyncKey(key)){
      enqueue({type:"del", key});
    }
  };

  // Public
  window.AMKO_KV = { hydrate, flush, shouldSyncKey, get status(){ return hasSupabase ? "REMOTE" : "LOCAL"; } };
})();
