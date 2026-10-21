export const pairingPageHtml = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Entrar no touri</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--red:#dc2626;--error:#b91c1c;--success:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#fafaf9;--muted:#a8a29e;--card:#1c1917;--line:#292524;--error:#f87171;--success:#4ade80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(28rem,calc(100vw - 2rem));background:var(--card);border:1px solid var(--line);border-radius:14px;padding:2rem}
h1{margin:0 0 .25rem;font-size:1.5rem;letter-spacing:-.02em}
h1 span{color:var(--red)}
h2{font-size:1rem;margin:1.5rem 0 .25rem}
p{margin:.25rem 0 1rem;color:var(--muted);font-size:.92rem}
label{display:block;font-size:.8rem;font-weight:600;margin:.75rem 0 .35rem}
input{width:100%;padding:.7rem .8rem;font:1rem system-ui,sans-serif;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
#code{font:600 1.1rem ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}
input:focus-visible,button:focus-visible{outline:2px solid var(--red);outline-offset:2px}
button{margin-top:.75rem;width:100%;padding:.75rem;border:0;border-radius:8px;background:var(--red);color:#fff;font:600 1rem system-ui,sans-serif;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
.status{margin-top:.65rem;font-size:.9rem;min-height:1.3rem}
.error{color:var(--error)}
.success{color:var(--success)}
hr{border:0;border-top:1px solid var(--line);margin:1.4rem 0}
code{font:.85rem ui-monospace,Menlo,monospace;background:var(--bg);padding:.1rem .35rem;border-radius:4px}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
<h1>touri<span>.</span></h1>
<p id="intro">Entre com seu e-mail ou use um código de pareamento.</p>
<div class="status" id="email-status" role="status" aria-live="polite"></div>
<form id="email-form" autocomplete="on">
<h2 id="email-heading">Entrar com e-mail</h2>
<p id="email-help">Enviaremos um link de uso único se este endereço fizer parte da equipe.</p>
<label id="email-label" for="email">E-mail</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="254" required>
<button id="email-button" type="submit">Enviar link de acesso</button>
</form>
<hr id="separator">
<form id="pair-form" autocomplete="off">
<h2 id="pair-heading">Usar código de pareamento</h2>
<p id="pair-help">No dispositivo já conectado, gere um código. Ele vale 5 minutos e só pode ser usado uma vez.</p>
<label id="code-label" for="code">Código de pareamento</label>
<input id="code" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" maxlength="14" required>
<button id="pair-button" type="submit">Conectar este dispositivo</button>
<div class="status error" id="pair-status" role="alert" aria-live="assertive"></div>
</form>
</main>
<script>
var english=navigator.language.toLowerCase().startsWith("en");
var copy={
title:english?"Sign in to touri":"Entrar no touri",
intro:english?"Sign in with your email or use a pairing code.":"Entre com seu e-mail ou use um código de pareamento.",
emailHeading:english?"Sign in with email":"Entrar com e-mail",
emailHelp:english?"We will send a one-time link if this address belongs to the team.":"Enviaremos um link de uso único se este endereço fizer parte da equipe.",
emailLabel:english?"Email":"E-mail",
emailButton:english?"Send sign-in link":"Enviar link de acesso",
emailSent:english?"If this address has access, a sign-in link will arrive by email.":"Se este endereço tiver acesso, enviaremos um link por e-mail.",
emailFailed:english?"Could not request a link. Check your connection and try again.":"Não foi possível pedir o link. Confira a conexão e tente novamente.",
pairHeading:english?"Use a pairing code":"Usar código de pareamento",
pairHelp:english?"On a signed-in device, create a code. It is valid for 5 minutes and works once.":"No dispositivo já conectado, gere um código. Ele vale 5 minutos e só pode ser usado uma vez.",
codeLabel:english?"Pairing code":"Código de pareamento",
pairButton:english?"Connect this device":"Conectar este dispositivo",
pairFailed:english?"Could not connect this device. Check the code and try again.":"Não foi possível conectar este dispositivo. Confira o código e tente novamente.",
redeeming:english?"Connecting this device…":"Conectando este dispositivo…",
invalidLink:english?"This link is invalid, expired, or already used. Request another one.":"Este link é inválido, expirou ou já foi usado. Peça outro link.",
connectionFailed:english?"Could not reach the server. Check your connection and try again.":"Não foi possível falar com o servidor. Confira a conexão e tente novamente."
};
document.documentElement.lang=english?"en":"pt-BR";
document.title=copy.title;
document.getElementById("intro").textContent=copy.intro;
document.getElementById("email-heading").textContent=copy.emailHeading;
document.getElementById("email-help").textContent=copy.emailHelp;
document.getElementById("email-label").textContent=copy.emailLabel;
document.getElementById("email-button").textContent=copy.emailButton;
document.getElementById("pair-heading").textContent=copy.pairHeading;
document.getElementById("pair-help").textContent=copy.pairHelp;
document.getElementById("code-label").textContent=copy.codeLabel;
document.getElementById("pair-button").textContent=copy.pairButton;
var emailForm=document.getElementById("email-form"),emailInput=document.getElementById("email"),emailButton=document.getElementById("email-button"),emailStatus=document.getElementById("email-status");
var pairForm=document.getElementById("pair-form"),codeInput=document.getElementById("code"),pairButton=document.getElementById("pair-button"),pairStatus=document.getElementById("pair-status");
const requestJson = async (path, body) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await response.json();
    return { ok: response.ok, json };
  } finally {
    clearTimeout(timeout);
  }
};
emailForm.addEventListener("submit",function(event){
event.preventDefault();emailButton.disabled=true;emailStatus.className="status";emailStatus.textContent="";
requestJson("/api/v1/auth/email",{email:emailInput.value}).then(function(result){if(result.ok){emailStatus.textContent=copy.emailSent;emailStatus.className="status success";return}emailStatus.textContent=copy.emailFailed}).catch(function(){emailStatus.textContent=copy.emailFailed}).finally(function(){emailButton.disabled=false});
});
pairForm.addEventListener("submit",function(event){
event.preventDefault();pairButton.disabled=true;pairStatus.textContent="";
requestJson("/pair",{code:codeInput.value,name:navigator.userAgent.slice(0,80)}).then(function(result){if(result.ok){location.replace("/");return}pairStatus.textContent=copy.pairFailed}).catch(function(){pairStatus.textContent=copy.connectionFailed}).finally(function(){pairButton.disabled=false});
});
var fragment=new URLSearchParams(location.hash.slice(1));var signInToken=fragment.get("signin");
const restoreSignIn = (message) => {
  // Restore keyboard access to requesting a fresh link after redemption fails.
  emailStatus.textContent = message;
  emailStatus.className = "status error";
  emailForm.hidden = false;
  pairForm.hidden = false;
  document.getElementById("separator").hidden = false;
  emailInput.focus();
};
if (signInToken) {
  history.replaceState(null, "", location.pathname + location.search);
  emailForm.hidden = true;
  pairForm.hidden = true;
  document.getElementById("separator").hidden = true;
  emailStatus.textContent = copy.redeeming;

  requestJson("/api/v1/auth/email/redeem", { token: signInToken, deviceName: navigator.userAgent.slice(0, 80) })
    .then((result) => {
      if (result.ok) {
        location.replace("/");
        return;
      }

      restoreSignIn(copy.invalidLink);
    })
    .catch(() => restoreSignIn(copy.connectionFailed));
}
</script>
</body>
</html>
`
