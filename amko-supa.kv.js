// === AMKO Supabase KV sync (client-side) ===
// Uses a single KV table on Supabase to sync JSON values across devices.
// Strategy:
//  - Hydrate: fetch keys from table, mirror into localStorage before app logic runs
//  - Patch: override setItem/removeItem to upsert/delete to Supabase (for selected keys)

(function(){
  // Require config + supabase-js
  if (!window.AMKO_SUPA || !window.supabase) {
    console.error("[AMKO_KV] Missing AMKO_SUPA config or supabase-js library.");
  }

  const client = window.supabase.createClient(window.AMKO_SUPA.url, window.AMKO_SUPA.anonKey);
  const TABLE = "amko_kv";

  // Keys to sync (prefix match); UI prefs are intentionally ignored
  const SYNC_PREFIXES = ["amko.", "akun", "transMini", "transaksi", "trx", "mutasi"];

  function shouldSyncKey(k){
    if(!k || typeof k !== "string") return false;
    return SYNC_PREFIXES.some(p => k.startsWith(p));
  }

  // Keep original LS ops
  const _set = Storage.prototype.setItem;
  const _get = Storage.prototype.getItem;
  const _rm  = Storage.prototype.removeItem;

  let _hydrating = false;
  let _queue = [];
  let _flushTimer = null;

  async function upsertKV(key, rawStr){
    // Try parse JSON; if fails, store as JSON string value
    let jsonVal;
    try{
      jsonVal = JSON.parse(rawStr);
    }catch(e){
      jsonVal = rawStr; // will be stored as a JSON string
    }
    return client.from(TABLE)
      .upsert({ key, value: jsonVal, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }

  async function deleteKV(key){
    return client.from(TABLE).delete().eq("key", key);
  }

  function enqueue(op){
    _queue.push(op);
    if(_flushTimer) return;
    _flushTimer = setTimeout(flush, 150); // debounce
  }

  async function flush(){
    clearTimeout(_flushTimer); _flushTimer = null;
    const ops = _queue.splice(0, _queue.length);
    for(const op of ops){
      try{
        if(op.type === "set") await upsertKV(op.key, op.value);
        if(op.type === "del") await deleteKV(op.key);
      }catch(e){
        console.warn("[AMKO_KV] Sync op failed:", op, e);
      }
    }
  }

  async function hydrate(){
    _hydrating = true;
    try{
      const orParts = SYNC_PREFIXES.map(p => `key.ilike.${p.replaceAll('.','\\.')}%`);
      const orFilter = orParts.join(",");
      const { data, error } = await client.from(TABLE).select("key,value").or(orFilter);
      if(error){ console.warn("[AMKO_KV] hydrate error:", error.message); }
      else if(Array.isArray(data)){
        for(const row of data){
          try{
            // Mirror into LS (bypass patched setItem to avoid loop)
            const str = (typeof row.value === "string") ? row.value : JSON.stringify(row.value);
            _set.call(localStorage, row.key, str);
          }catch(e){}
        }
      }
    }finally{
      _hydrating = false;
    }
  }

  // Patch localStorage
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

  window.AMKO_KV = { hydrate, flush, shouldSyncKey };
})();

// Convenience boot helper to ensure hydrate before app code runs:
window.AMKO_BOOT = async function(run){
  try{
    if(window.AMKO_KV?.hydrate) await window.AMKO_KV.hydrate();
  }catch(e){ console.warn("[AMKO_BOOT] hydrate skipped.", e); }
  // run app
  return run && run();
};
