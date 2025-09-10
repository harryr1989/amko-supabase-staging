// amko-supa.js — Minimal KV sync that doesn't change page flow
// Exposes: window.amkoSupa.auto()

;(function(){
  const TABLE = "amko_kv";
  const PREFIXES = ["amko.", "akun", "transMini", "transaksi", "trx", "mutasi"];

  function shouldSync(k){
    if (!k || typeof k !== "string") return false;
    return PREFIXES.some(p => k.startsWith(p));
  }

  function safeJSON(str, fallback=null){
    try { return JSON.parse(str); } catch(e){ return fallback === undefined ? str : fallback; }
  }

  const api = {
    client: null,
    status: "LOCAL",  // "REMOTE" when client ready
    _set: Storage.prototype.setItem,
    _rm: Storage.prototype.removeItem,
    _hydrating: false,
    _q: [],
    _t: null,

    init(){
      try{
        if (!window.supabase || !window.AMKO_SUPA || !AMKO_SUPA.url || !AMKO_SUPA.anonKey) return;
        this.client = window.supabase.createClient(AMKO_SUPA.url, AMKO_SUPA.anonKey);
        this.status = "REMOTE";
      }catch(e){
        console.warn("[amkoSupa] createClient failed, LOCAL mode:", e);
        this.client = null;
        this.status = "LOCAL";
      }
    },

    async upsert(key, raw){
      if (!this.client) return;
      const value = safeJSON(raw, raw);
      return this.client.from(TABLE).upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    },

    async del(key){
      if (!this.client) return;
      return this.client.from(TABLE).delete().eq("key", key);
    },

    enqueue(op){
      if (!this.client) return; // local-only; don't queue
      this._q.push(op);
      if (this._t) return;
      this._t = setTimeout(() => this.flush(), 150);
    },

    async flush(){
      clearTimeout(this._t); this._t = null;
      const ops = this._q.splice(0, this._q.length);
      for (const op of ops){
        try{
          if (op.type === "set") await this.upsert(op.key, op.value);
          if (op.type === "del") await this.del(op.key);
        }catch(e){
          console.warn("[amkoSupa] sync failed:", op, e);
        }
      }
    },

    async hydrate(){
      this._hydrating = true;
      try{
        if (!this.client) return;
        const or = PREFIXES.map(p => `key.ilike.${p.replaceAll('.','\\.')}%`).join(",");
        const { data, error } = await this.client.from(TABLE).select("key,value").or(or);
        if (error) { console.warn("[amkoSupa] hydrate error:", error.message); return; }
        if (Array.isArray(data)){
          for (const row of data){
            try{
              const str = (typeof row.value === "string") ? row.value : JSON.stringify(row.value);
              this._set.call(localStorage, row.key, str); // bypass patched setItem to avoid loops
            }catch(e){/* ignore */}
          }
        }
      } finally {
        this._hydrating = false;
      }
    },

    patchLocalStorage(){
      const self = this;
      Storage.prototype.setItem = function(k, v){
        self._set.call(this, k, v);
        if (!self._hydrating && shouldSync(k)) self.enqueue({type:"set", key:k, value:String(v)});
      };
      Storage.prototype.removeItem = function(k){
        self._rm.call(this, k);
        if (!self._hydrating && shouldSync(k)) self.enqueue({type:"del", key:k});
      };
    },

    async auto(){
      // 1) init supabase (non-blocking app code)
      this.init();
      // 2) hydrate (non-blocking; app already loaded its own data)
      this.hydrate();
      // 3) patch storage to mirror future writes
      this.patchLocalStorage();
      // Expose status for Console checks
      window.AMKO_KV = { status: this.status };
    }
  };

  window.amkoSupa = api;
})();
