/* Liga os formulários do site ao CRM Flurtek (POST /api/public/leads).
   Uso: <script src="crm-forms.js" data-crm-url="https://crm.exemplo.com.br" data-site-key="CHAVE"></script>
   Sem data-crm-url o script não faz nada (o formulário continua só visual). */
(function () {
  var me = document.currentScript;
  var SAME = !!(me && me.hasAttribute("data-same-origin"));
  var URL_ = SAME ? "" : me && me.dataset.crmUrl;
  var KEY = me && me.dataset.siteKey;
  if ((!SAME && !URL_) || !KEY || KEY === "__SITE_KEY__") return;

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return String(Date.now()) + Math.random().toString(16).slice(2);
  }
  function utm() {
    var p = new URLSearchParams(location.search), o = {};
    if (p.get("utm_source")) o.source = p.get("utm_source");
    if (p.get("utm_medium")) o.medium = p.get("utm_medium");
    if (p.get("utm_campaign")) o.campaign = p.get("utm_campaign");
    return Object.keys(o).length ? o : undefined;
  }
  // Em listas de escolha envia o texto que a pessoa viu (ex.: "20L"), exceto o estado, que vai como sigla.
  function field(f, name) {
    var e = f.elements[name];
    if (!e) return "";
    if (e.tagName === "SELECT" && name !== "uf" && e.selectedIndex >= 0) return String(e.options[e.selectedIndex].text || "").trim();
    return String(e.value || "").trim();
  }

  document.querySelectorAll("form[data-crm-form]").forEach(function (f) {
    f.removeAttribute("onsubmit");

    // Campo-isca invisível: humanos não preenchem, robôs sim.
    var trap = document.createElement("input");
    trap.type = "text"; trap.name = "website"; trap.tabIndex = -1; trap.autocomplete = "off"; trap.setAttribute("aria-hidden", "true");
    trap.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0";
    f.appendChild(trap);

    var box = document.createElement("p");
    box.setAttribute("role", "status");
    box.style.cssText = "margin:12px 0 0;padding:12px 14px;border-radius:12px;font-size:14px;display:none;line-height:1.4";
    f.appendChild(box);
    function say(msg, ok) {
      box.textContent = msg; box.style.display = "block";
      box.style.background = ok ? "#e3f4ea" : "#fbe7e5"; box.style.color = ok ? "#157a45" : "#b3261e";
    }

    var submissionId = uid();
    f.addEventListener("submit", function (ev) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (f.reportValidity && !f.reportValidity()) return;

      var kind = f.dataset.crmForm;
      var consentBox = f.elements["consent"];
      var implicit = f.dataset.consent === "implicit";
      var note = f.querySelector("small");
      var payload = {
        form: kind,
        name: field(f, "name"),
        email: field(f, "email"),
        phone: field(f, "phone"),
        company: field(f, "company"),
        uf: field(f, "uf"),
        city: field(f, "city"),
        segment: field(f, "segment"),
        cnpj: field(f, "cnpj"),
        product: field(f, "product"),
        volume: field(f, "volume"),
        frequency: field(f, "frequency"),
        message: field(f, "message"),
        subject: (f.querySelector(".subjects .on") || {}).dataset ? f.querySelector(".subjects .on").dataset.s : field(f, "subject"),
        consent: consentBox ? !!consentBox.checked : implicit,
        consentText: consentBox ? "Li e concordo com a Política de Privacidade (formulário " + kind + ")." : (note ? note.textContent.trim() : ""),
        pageUrl: location.origin + location.pathname,
        submissionId: submissionId,
        utm: utm(),
        website: trap.value
      };
      var cityuf = field(f, "cityuf"), m = cityuf.match(/^(.+?)\s*\/\s*([A-Za-z]{2})$/);
      if (m) { payload.city = m[1].trim(); payload.uf = m[2].toUpperCase(); } else if (cityuf) { payload.city = cityuf; }
      var profile = field(f, "profile");
      if (profile) payload.message = ("Perfil: " + profile + (payload.message ? "\n" + payload.message : ""));
      if (kind === "cotacao" && !payload.product) payload.product = f.dataset.product || "";
      if (kind === "cotacao" && payload.product && /^\d/.test(payload.volume) === false && f.dataset.product) payload.product = f.dataset.product;

      var btn = f.querySelector("button[type=submit]");
      if (btn) btn.disabled = true;
      say("Enviando…", true);
      fetch(URL_ + "/api/public/leads", {
        method: "POST",
        headers: { "content-type": "application/json", "x-site-key": KEY },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
        .then(function (x) {
          if (x.r.ok && x.j.ok) {
            say("Recebemos! Seu protocolo é " + x.j.reference + ". Em breve entraremos em contato.", true);
            f.reset(); submissionId = uid();
          } else if (x.r.status === 422 && x.j.fields) {
            say(Object.keys(x.j.fields).map(function (k) { return x.j.fields[k]; }).join(" "), false);
          } else if (x.r.status === 429) {
            say("Muitas tentativas. Aguarde um minuto e tente de novo.", false);
          } else {
            say("Não foi possível enviar agora. Tente de novo ou fale pelo WhatsApp.", false);
          }
        })
        .catch(function () { say("Não foi possível enviar agora. Verifique sua conexão e tente de novo.", false); })
        .then(function () { if (btn) btn.disabled = false; });
    }, true);
  });
})();
