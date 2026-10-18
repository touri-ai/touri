import type { Server } from "bun"

const page = (body: string, script = ""): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>touri fixture</title><style>body{font:16px sans-serif;margin:24px}#overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2}#covered{position:relative;z-index:1}</style></head><body>${body}<script>${script}</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )

export const startBrowserFixtureServer = (): Server<undefined> =>
  Bun.serve<undefined>({
    port: 0,
    fetch: (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname === "/basic") return page('<button id="save">Save</button><input aria-label="Name">')
      if (pathname === "/mutating-link" || pathname === "/click-destination")
        return page(
          '<a id="changing-link" href="/click-destination"><img alt="Go to destination" width="80" height="30" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2230%22/%3E"></a><div style="height:1800px"></div><a id="below-fold" href="/click-destination">Below fold</a>',
          "if(location.pathname==='/mutating-link')localStorage.setItem('r9ClickCount','0');document.addEventListener('click',e=>{if(e.target.closest('a')){localStorage.setItem('r9ClickCount',String(Number(localStorage.getItem('r9ClickCount'))+1));document.body.dataset.clicked='yes'}});window.replaceLink=()=>{const link=document.querySelector('#changing-link');link.replaceWith(link.cloneNode(true))}",
        )
      if (pathname === "/ambiguous") return page('<button id="save-a">Save</button><button id="save-b">Save</button>')
      if (pathname === "/overlay")
        return page(
          '<button id="covered">Save</button><div id="overlay" role="dialog">Modal overlay</div>',
          "document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('#overlay')?.remove()})",
        )
      if (pathname === "/partial")
        return page(
          '<button id="partial-target">Partially covered</button><div id="partial-overlay">Overlay</div>',
          "document.querySelector('#partial-target').style.cssText='width:240px;height:80px;position:relative;z-index:1';document.querySelector('#partial-overlay').style.cssText='position:absolute;left:144px;top:24px;width:140px;height:80px;z-index:2;background:#f00'",
        )
      // A large actionable page exercises the snapshot inspection cap.
      if (pathname === "/large")
        return page(
          '<div id="buttons">' +
            Array.from({ length: 1000 }, (_, index) => `<button>Button ${index}</button>`).join("") +
            "</div>",
        )
      if (pathname === "/huge")
        return page(
          `<canvas width="1200" height="400"></canvas><h1>${"body text ".repeat(6000)}</h1>`,
          "document.title='long title '.repeat(10000);const c=document.querySelector('canvas').getContext('2d');c.fillStyle='blue';c.fillRect(0,0,1200,400)",
        )
      if (pathname === "/canvas")
        return page(
          '<canvas width="900" height="300"></canvas><p>A canvas fixture</p>',
          "const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,900,300)",
        )
      if (pathname === "/plain")
        return page(`<h1>Readable document</h1><h2>Summary</h2><h2>Details</h2><p>${"plain text ".repeat(50)}</p>`)
      if (pathname === "/secret")
        return page(
          '<label>User <input aria-label="User"></label><label>Password <input id="password" type="password" aria-label="Password"></label><button id="submit">Submit</button>',
          "document.querySelector('#submit').addEventListener('click',()=>{location.href=document.querySelector('#password').value==='hunter2-secret'?'/secret-success':'/secret-failure'})",
        )
      if (pathname === "/secret-success") return page("<p>Secret accepted</p>")
      if (pathname === "/secret-failure") return page("<p>Secret rejected</p>")
      if (pathname === "/redaction")
        return page(
          '<p id="secret-text">hunter2-secret</p><input id="secret-value" value="hunter2-secret">',
          "document.title='hunter2-secret title';window.secretNote='hunter2-secret note'",
        )
      if (pathname === "/dialog")
        return page(
          '<button id="confirm">Confirm</button>',
          "document.querySelector('#confirm').addEventListener('click',()=>confirm('Discard post?'))",
        )
      if (pathname === "/popup")
        return page(
          '<button id="popup">Open popup</button>',
          "document.querySelector('#popup').addEventListener('click',()=>window.open('/popup-child','child','width=400,height=300'))",
        )
      if (pathname === "/popup-child") return page("<h1>Popup</h1>")
      if (pathname === "/cookie") return page("<p>Cookie page</p>", "document.cookie='touri_fixture=present; path=/'")
      if (pathname === "/ordering")
        return page(
          '<button id="ordered">Order</button>',
          "window.order=[];document.querySelector('#ordered').addEventListener('click',()=>window.order.push({index:window.order.length,at:performance.now()}))",
        )
      if (pathname === "/navigate-timer")
        return page('<p id="before-navigation">Before navigation</p>', "setTimeout(()=>{location.href='/basic'},0)")
      if (pathname === "/clear-fields")
        return page(
          '<input id="plain" aria-label="Plain" value="old@example.com"><input id="controlled" aria-label="Controlled" value=""><textarea id="area" aria-label="Area">old text</textarea><div id="editable" contenteditable="true" role="textbox" aria-label="Editable">old rich</div>',
          "const c=document.querySelector('#controlled');const state={v:'prefilled@example.com'};const render=()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(c,state.v)};render();c.addEventListener('input',()=>{state.v=c.value;render()});window.controlledState=state",
        )
      if (pathname === "/frame") {
        const label = new URL(request.url).searchParams.get("label") ?? "Frame button"
        const id = label.toLowerCase().includes("cross") ? "cross-frame-target" : "same-frame-target"
        return page(`<button id="${id}">${label}</button><input aria-label="${label} input">`)
      }
      if (pathname === "/frames") {
        const port = new URL(request.url).port
        return page(
          `<iframe title="same-origin" src="/frame?label=Same%20frame"></iframe><iframe title="cross-origin" src="http://localhost:${port}/frame?label=Cross%20frame"></iframe>`,
        )
      }
      if (pathname === "/shadow")
        return page(
          '<div id="shadow-host"></div><input type="range" aria-label="Native range">',
          "const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});root.innerHTML='<button id=shadow-target>Shadow save</button>'",
        )
      if (pathname === "/delayed") {
        const delay = Number(new URL(request.url).searchParams.get("ms") ?? "600")
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(page('<h1 id="ready">Delayed ready</h1><button>Delayed button</button>')), delay),
        )
      }
      if (pathname === "/never") return new Promise<Response>(() => {})
      if (pathname === "/hang-resource") return new Promise<Response>(() => {})
      if (pathname === "/hanging-subresource")
        return page('<h1>Usable page</h1><button>Usable button</button><img alt="" src="/hang-resource">')
      if (pathname === "/smooth")
        return page(
          '<style>html{scroll-behavior:smooth}</style><a id="top" href="/click-destination">Top link</a><div style="height:7000px"></div><a id="footer-link" href="/click-destination">Footer link</a><div style="height:600px"></div>',
        )
      if (pathname === "/disabled-later")
        return page(
          '<button id="later" disabled>Enable me</button><button id="never" disabled>Never enabled</button>',
          "window.clicks=0;document.addEventListener('click',e=>{if(e.target.id==='later')window.clicks+=1});setTimeout(()=>{document.querySelector('#later').disabled=false},500)",
        )
      if (pathname === "/tall-noise")
        return page(
          '<canvas id="noise" width="1280" height="4000"></canvas><div style="height:40000px;background:linear-gradient(#fff,#000)"></div>',
          "const c=document.querySelector('#noise');const x=c.getContext('2d');const d=x.createImageData(1280,4000);for(let i=0;i<d.data.length;i++)d.data[i]=i%4===3?255:Math.floor(Math.random()*256);x.putImageData(d,0,0)",
        )
      if (pathname === "/popup-link")
        return page('<a id="blank" target="_blank" href="/popup-child">Open in new tab</a>')
      if (pathname === "/wait") return page('<p id="status">waiting</p>')
      if (pathname === "/challenge-reference")
        return new Response(
          "<!doctype html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don't have permission to access this page on this server.</p><p>Reference #18.1a2b3c4d.1700000000.5e6f7a8b</p></body></html>",
          { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
        )
      if (pathname === "/challenge-header")
        return new Response(
          "<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser.</p></body></html>",
          { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" } },
        )
      if (pathname === "/forbidden")
        return new Response(page("<h1>Access denied</h1><p>Ask your admin for access to this project.</p>").body, {
          status: 403,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      return new Response(page("<p>fixture</p>").body, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    },
  })
