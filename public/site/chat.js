/* Chat do site Flurtek: conversa com o assistente virtual (IA) e, se preciso, com a equipe.
   Uso: <script src="/site/chat.js" data-site-key="CHAVE" defer></script>  (o servidor injeta a tag) */
(function () {
  var me = document.currentScript;
  var KEY = me && me.dataset.siteKey;
  if (!KEY || KEY === "__SITE_KEY__" || document.getElementById("fl-chat")) return;
  var WA = "https://api.whatsapp.com/send?phone=555491268955";
  var STORE = "flurtek.chat.v1";
  var sessionId = "", cursor = "", timer = null, open = false, busy = false, seen = {}, mode = "AGENTE";

  function store(v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(STORE) || "null"); localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) { return null; } }
  var saved = store();
  if (saved && saved.s) { sessionId = saved.s; cursor = saved.c || ""; }

  var css = "#fl-chat,#fl-chat *{box-sizing:border-box}#fl-chat{position:fixed;right:24px;bottom:24px;z-index:70;font:15px/1.45 Inter,system-ui,sans-serif;color:#141414}" +
    "#fl-chat .fl-fab{width:60px;height:60px;border-radius:50%;border:0;background:#cedc00;color:#141414;display:grid;place-items:center;cursor:pointer;box-shadow:0 14px 34px -8px rgba(0,0,0,.45);transition:transform .2s}" +
    "#fl-chat .fl-fab:hover{transform:scale(1.07)}#fl-chat .fl-fab:focus-visible,#fl-chat button:focus-visible,#fl-chat input:focus-visible,#fl-chat textarea:focus-visible,#fl-chat a:focus-visible{outline:3px solid #141414;outline-offset:2px}" +
    "#fl-chat .fl-fab svg{width:28px;height:28px}#fl-chat .fl-dot{position:absolute;top:2px;right:2px;width:14px;height:14px;border-radius:50%;background:#e5484d;border:2px solid #fff;display:none}" +
    "#fl-chat .fl-panel{position:absolute;right:0;bottom:76px;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 140px));background:#fff;border-radius:20px;box-shadow:0 24px 60px -12px rgba(0,0,0,.45);display:none;flex-direction:column;overflow:hidden;border:1px solid #e4e4de}" +
    "#fl-chat.fl-open .fl-panel{display:flex}" +
    "#fl-chat .fl-head{background:#141414;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px}#fl-chat .fl-head b{display:block;font:700 15px/1.2 Sora,Inter,sans-serif}#fl-chat .fl-head small{color:#c9c9c9;font-size:12px}" +
    "#fl-chat .fl-av{width:38px;height:38px;border-radius:50%;background:#cedc00;color:#141414;display:grid;place-items:center;font:800 16px Sora,sans-serif;flex:none}" +
    "#fl-chat .fl-x{margin-left:auto;background:transparent;border:0;color:#fff;cursor:pointer;width:36px;height:36px;border-radius:50%;font-size:22px;line-height:1}#fl-chat .fl-x:hover{background:rgba(255,255,255,.12)}" +
    "#fl-chat .fl-body{flex:1;overflow-y:auto;padding:16px;background:#f5f5f0;display:flex;flex-direction:column;gap:10px}" +
    "#fl-chat .fl-msg{max-width:86%;padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word;font-size:14.5px}" +
    "#fl-chat .fl-bot{background:#fff;border:1px solid #e4e4de;border-bottom-left-radius:4px;align-self:flex-start}#fl-chat .fl-team{background:#eef3b0;border:1px solid #d8e27a;border-bottom-left-radius:4px;align-self:flex-start}#fl-chat .fl-me{background:#141414;color:#fff;border-bottom-right-radius:4px;align-self:flex-end}" +
    "#fl-chat .fl-who{font:600 11px Inter,sans-serif;color:#6b7300;margin:0 0 2px 4px;align-self:flex-start}" +
    "#fl-chat .fl-typing{align-self:flex-start;color:#555;font-size:13px;padding:2px 6px}#fl-chat .fl-hint{font-size:12.5px;color:#555;background:#fff;border:1px dashed #c9c9c0;border-radius:12px;padding:8px 12px}" +
    "#fl-chat .fl-chips{display:flex;flex-wrap:wrap;gap:8px}#fl-chat .fl-chip{border:1.5px solid #d4d4cc;background:#fff;border-radius:999px;padding:8px 12px;font:600 13px Inter,sans-serif;cursor:pointer;color:#141414}#fl-chat .fl-chip:hover{border-color:#6b7300}" +
    "#fl-chat .fl-foot{border-top:1px solid #e4e4de;padding:10px;background:#fff}#fl-chat .fl-row{display:flex;gap:8px;align-items:flex-end}" +
    "#fl-chat textarea{flex:1;resize:none;border:1.5px solid #d4d4cc;border-radius:14px;padding:10px 12px;font:15px/1.35 Inter,sans-serif;max-height:96px;min-height:44px}" +
    "#fl-chat .fl-send{border:0;background:#cedc00;color:#141414;font:700 14px Sora,sans-serif;border-radius:14px;padding:0 16px;height:44px;cursor:pointer}#fl-chat .fl-send:disabled{opacity:.5;cursor:default}" +
    "#fl-chat .fl-consent{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#333;margin:0 0 8px}#fl-chat .fl-consent input{margin-top:3px;width:18px;height:18px;flex:none}#fl-chat .fl-consent a{color:#4a5200;font-weight:600}" +
    "#fl-chat .fl-err{color:#b3261e;font-size:12.5px;margin:0 0 6px}#fl-chat .fl-small{font-size:11.5px;color:#6b6b6b;margin:8px 2px 0}#fl-chat .fl-wa{display:inline-block;margin-top:2px;font:700 13px Inter,sans-serif;color:#0b6b3a;text-decoration:underline}" +
    "@media(max-width:520px){#fl-chat{right:16px;bottom:16px}#fl-chat .fl-panel{position:fixed;inset:12px 12px 84px 12px;width:auto;height:auto}}" +
    "@media(prefers-reduced-motion:reduce){#fl-chat .fl-fab{transition:none}}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  var root = document.createElement("div"); root.id = "fl-chat";
  root.innerHTML =
    '<div class="fl-panel" role="dialog" aria-label="Chat com o assistente da Flurtek" aria-modal="false">' +
    '<div class="fl-head"><div class="fl-av" aria-hidden="true">F</div><div><b>Assistente Flurtek</b><small>Atendimento virtual (IA) · equipe humana quando preciso</small></div><button class="fl-x" type="button" aria-label="Fechar chat">&times;</button></div>' +
    '<div class="fl-body" role="log" aria-live="polite" aria-label="Mensagens"></div>' +
    '<div class="fl-foot"><div class="fl-consent-wrap"></div><p class="fl-err" role="alert" hidden></p>' +
    '<form class="fl-row" autocomplete="off"><input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;opacity:0;width:1px;height:1px">' +
    '<textarea rows="1" maxlength="1000" placeholder="Escreva sua mensagem" aria-label="Sua mensagem"></textarea><button class="fl-send" type="submit">Enviar</button></form>' +
    '<p class="fl-small">Não envie senhas nem dados de cartão. Ao conversar, você concorda com nossa <a href="/politica-de-privacidade" target="_blank" rel="noopener">Política de Privacidade</a>.</p></div></div>' +
    '<button class="fl-fab" type="button" aria-label="Abrir chat com o assistente" aria-expanded="false"><span class="fl-dot"></span>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/></svg></button>';
  document.body.appendChild(root);

  var $ = function (s) { return root.querySelector(s); };
  var body = $(".fl-body"), form = $(".fl-row"), ta = form.querySelector("textarea"), sendBtn = $(".fl-send"), err = $(".fl-err"), fab = $(".fl-fab"), dot = $(".fl-dot"), consentWrap = $(".fl-consent-wrap");
  var typing = null, hintShown = false, waitingSince = 0;

  function scroll() { body.scrollTop = body.scrollHeight; }
  function add(kind, text, who) {
    if (who) { var w = document.createElement("div"); w.className = "fl-who"; w.textContent = who; body.appendChild(w); }
    var d = document.createElement("div"); d.className = "fl-msg fl-" + kind; d.textContent = text; body.appendChild(d); scroll(); return d;
  }
  function showErr(m) { err.hidden = !m; err.textContent = m || ""; }
  function setTyping(on) {
    if (on && !typing) { typing = document.createElement("div"); typing.className = "fl-typing"; typing.textContent = "Assistente digitando…"; body.appendChild(typing); scroll(); }
    if (!on && typing) { typing.remove(); typing = null; }
  }
  function waLink(text) {
    var a = document.createElement("a"); a.className = "fl-wa"; a.href = WA; a.target = "_blank"; a.rel = "noopener"; a.textContent = text; return a;
  }
  function renderConsent() {
    consentWrap.innerHTML = "";
    if (sessionId) return;
    var l = document.createElement("label"); l.className = "fl-consent";
    l.innerHTML = '<input type="checkbox" id="fl-consent"><span>Li e concordo com o tratamento dos meus dados para o atendimento (LGPD).</span>';
    consentWrap.appendChild(l);
  }

  function greet() {
    add("bot", "Olá! Eu sou o assistente virtual da Flurtek. Posso tirar dúvidas sobre água desmineralizada e aditivo de radiador, indicar o volume ideal e encaminhar uma cotação. Como posso ajudar?");
    var chips = document.createElement("div"); chips.className = "fl-chips";
    ["Para que serve a água desmineralizada?", "Quero cotar água 20L", "Quais volumes vocês têm?", "Falar com um atendente"].forEach(function (t) {
      var b = document.createElement("button"); b.type = "button"; b.className = "fl-chip"; b.textContent = t;
      b.addEventListener("click", function () { chips.remove(); if (t === "Falar com um atendente") { add("bot", "Claro! Para falar com uma pessoa agora, use o WhatsApp:"); body.lastChild.appendChild(document.createElement("br")); body.lastChild.appendChild(waLink("Abrir WhatsApp (54) 99126-8955")); return; } ta.value = t; send(); });
      chips.appendChild(b);
    });
    body.appendChild(chips);
  }

  function api(method, path, data) {
    return fetch("/api/public/chat" + path, { method: method, headers: method === "POST" ? { "content-type": "application/json", "x-site-key": KEY } : {}, body: data ? JSON.stringify(data) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); });
  }

  function apply(j) {
    (j.messages || []).forEach(function (m) {
      if (seen[m.id]) return; seen[m.id] = 1; cursor = m.id;
      if (m.author === "EQUIPE") add("team", m.text, "Equipe Flurtek"); else add("bot", m.text);
      if (!open) dot.style.display = "block";
    });
    if (sessionId) store({ s: sessionId, c: cursor });
    mode = j.mode || mode;
    if (j.waiting) {
      if (!waitingSince) waitingSince = Date.now();
      setTyping(mode !== "HUMANO");
      if (Date.now() - waitingSince > 30000 && !hintShown) {
        hintShown = true; var h = add("bot", mode === "HUMANO" ? "Nossa equipe já foi avisada e responde por aqui assim que possível." : "Estou levando um pouco mais que o normal. Se for urgente, fale com a equipe no WhatsApp:");
        h.classList.add("fl-hint"); h.appendChild(document.createElement("br")); h.appendChild(waLink("Abrir WhatsApp"));
      }
    } else { waitingSince = 0; hintShown = false; setTyping(false); }
  }

  function poll() {
    clearTimeout(timer);
    if (!sessionId) return;
    var wait = open ? (waitingSince ? 1800 : 4000) : 15000;
    if (document.hidden) wait = 20000;
    api("GET", "?s=" + encodeURIComponent(sessionId) + (cursor ? "&after=" + encodeURIComponent(cursor) : "")).then(function (x) {
      if (x.r.status === 404) { sessionId = ""; cursor = ""; store({}); renderConsent(); return; }
      if (x.j && x.j.ok) apply(x.j);
    }).catch(function () {}).then(function () { timer = setTimeout(poll, wait); });
  }

  function send() {
    if (busy) return;
    var text = ta.value.trim(); if (!text) return;
    var consent = root.querySelector("#fl-consent");
    if (!sessionId && !(consent && consent.checked)) { showErr("Marque a caixa de concordância para começar a conversa."); return; }
    showErr(""); busy = true; sendBtn.disabled = true;
    api("POST", "", { sessionId: sessionId || undefined, message: text, consent: !!(consent && consent.checked), website: form.elements.website.value, pageUrl: location.origin + location.pathname }).then(function (x) {
      if (x.j && x.j.ok) {
        body.querySelectorAll(".fl-chips").forEach(function (c) { c.remove(); });
        add("me", text); ta.value = ""; ta.style.height = "auto";
        sessionId = x.j.sessionId; renderConsent(); apply(x.j); poll();
      } else if (x.r.status === 429) showErr(x.j.message || "Muitas mensagens em pouco tempo. Aguarde um instante.");
      else showErr(x.j.message || "Não foi possível enviar agora. Tente de novo ou use o WhatsApp.");
    }).catch(function () { showErr("Sem conexão. Verifique a internet e tente de novo."); }).then(function () { busy = false; sendBtn.disabled = false; ta.focus(); });
  }

  function toggle(v) {
    open = v; root.classList.toggle("fl-open", v); fab.setAttribute("aria-expanded", String(v));
    fab.setAttribute("aria-label", v ? "Fechar chat" : "Abrir chat com o assistente");
    if (v) { dot.style.display = "none"; if (!body.childNodes.length) { greet(); if (sessionId) restore(); } setTimeout(function () { ta.focus(); }, 50); poll(); }
  }
  function restore() {
    // Sessão salva: busca o histórico visível desde o começo.
    var c = cursor; cursor = ""; seen = {};
    api("GET", "?s=" + encodeURIComponent(sessionId)).then(function (x) {
      if (x.j && x.j.ok) { if (x.j.messages.length) { body.innerHTML = ""; add("bot", "Bem-vindo de volta! Aqui está nossa conversa:"); } apply(x.j); } else cursor = c;
    }).catch(function () { cursor = c; });
  }

  fab.addEventListener("click", function () { toggle(!open); });
  $(".fl-x").addEventListener("click", function () { toggle(false); fab.focus(); });
  form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  ta.addEventListener("input", function () { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 96) + "px"; });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) { toggle(false); fab.focus(); } });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && sessionId) poll(); });
  renderConsent();
  if (sessionId) poll();
})();
