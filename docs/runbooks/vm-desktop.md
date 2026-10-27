# Tela da VM

No painel de um bot com máquina virtual, abra **Computador** e **Entrar**
(ou **Ligar computador**). **Abrir em janela** usa o mesmo viewer. A conexão
começa em **Somente observar**. **Controlar** exige a permissão de controle do
computador do bot; **Parar controle** ou **Reconectar** retorna à observação.
Modais e menus que cobrem o viewer pausam a sessão. Ao voltar, o controle precisa
ser solicitado novamente.

A parada global, pelo atalho, tray ou `POST /computer/kill`, encerra as sessões
de controle e libera teclas e botões pressionados. Sessões de observação
continuam disponíveis. Revogar a permissão do bot também encerra o controle.

Clique na tela ou no campo **Digitar na VM** para usar o teclado. No Mac, ⌘
equivale a Ctrl no Linux convidado; Option continua disponível para acentos.
Texto de IME é enviado ao confirmar a composição, uma única vez. Perder o foco
libera teclas pressionadas e descarta composições incompletas.

O guest usa Xvfb em `:99`, com x11vnc em `127.0.0.1:5900`. O runtime encaminha
esse serviço pelo caminho existente de port-forward via exec; a UI recebe uma
sessão WebSocket autenticada, de uso único e com 15 segundos para conectar. O
sidecar filtra mensagens de entrada em sessões de observação. Não há porta VNC
publicada na interface de rede da VM.

O x11vnc exige uma senha aleatória de oito caracteres (limite do VNC clássico),
rotacionada pelo sidecar a cada boot/reinício. O arquivo `rfbauth` fica em
`/tmp/touri-vnc/passwd`, com modo 0600 dentro de uma pasta 0700. O servidor começa
com um arquivo aleatório, antes da configuração, e recebe a credencial real no
payload AES-GCM do descritor selado. O proxy responde ao desafio RFB; a senha
não chega ao React/noVNC, URLs, eventos ou logs. A porta encaminhada exige a
mesma autenticação de processos locais que tentem se conectar diretamente.

Um pulso de 8 × 8 pixels no canto inferior direito percorre X11, VNC e o canvas.
A UI verifica o pulso e o ritmo de animation frames. Sem progresso por oito
segundos, mostra **Tela travada — reconectar**, encerra a sessão e desativa a
entrada. Ao voltar de uma janela oculta, a aferição do pulso e dos frames recomeça.
**Conectando** permanece até o primeiro frame com pulso: o evento `connect` do
noVNC confirma o handshake, mas pode ocorrer antes de o canvas receber pixels.

Revalidar uma VM já ligada e sem leases não publica `starting`: esse estado
desmonta o viewer e descarta o pedido de controle. Cancelar a aquisição de uma
sessão também não marca uma VM ligada como parada.

O atalho **Ctrl+Alt+Cmd+.** é capturado antes do teclado da VM, inclusive com
foco em **Digitar na VM**. No app nativo ele interrompe a entrada do host e
notifica todas as janelas e o sidecar; no browser usa `POST /computer/kill`.

Para diagnosticar, execute
`TOURI_DESKTOP_TRACE=1 bun test sidecar/test/vm -t "real noVNC"` isoladamente.
Os logs de `vm.desktop` mostram pedido, permissão, concessão, claim, epoch e
motivo de fechamento. O trace acrescenta tamanhos recebidos/encaminhados pelo
gate, sem registrar teclas ou credenciais. O teste prepara o foco da página
no guest com `Page.bringToFront`; navegação/autofocus por CDP não bastam para
entregar entrada X11 à página. Também verifica pixels da janela do guest,
Unicode, atalho no textarea, notificação do host em outra janela e frames congelados.

A imagem atual é `touri-bot:10`, com `-rfbauth`, `-norc`, `-xkb` e `-add_keysyms` no init.
A `:4` iniciava sem senha e supervisionava o PID do x11vnc: substituí-lo durante
o boot encerraria o guest. A nova imagem permite iniciar protegido, sem uma
migração de `.x11vncrc` e um reinício adicional em runtime. O runtime existente
faz a atualização de imagem e preserva o volume do bot. Não há mudança de schema.
O viewer usa `@novnc/novnc` 1.7.0 sem alterações; as fontes e atribuições MPL-2.0
estão referenciadas em `THIRD_PARTY_NOTICES`, que acompanha o bundle. Os arquivos
originais do touri continuam Apache-2.0.

Validação:

- `bun test sidecar/test/vm`: protocolos, autenticação, permissão, leases,
  kill switch e o runtime de VM.
- `cd ui && bun run test`: viewer, reconexão, IME, teclado e client API.
- `sidecar/test/vm/desktop-local.test.ts` usa Xvfb, x11vnc, Python e o Chromium
  instalado pelo Playwright no Linux. Aloca display e porta livres, cria somente
  processos descartáveis e testa noVNC real, Unicode/IME, mouse e congelamento.
  Também recusa logins sem senha/com senha errada, verifica a rotação do arquivo
  sem trocar o PID do servidor e confirma que as senhas não aparecem no log.
- `sidecar/test/vm/desktop-integration.test.ts` usa uma VM descartável do Apple
  container no Mac. Verifica o port-forward completo e suspende apenas o VNC
  dessa VM para testar a reconexão. Esse teste é pulado no Linux.
  A página que captura `Olá 日本` aguarda o carregamento e o foco antes de enviar
  teclas. A UI usa Latin-1 até U+00FF e `0x01000000 + codepoint` para os demais
  caracteres; x11vnc adiciona keysyms ausentes ao mapa X11, inclusive texto de IME.

### Dock e navegador (imagem 10)

O dock oferece **Navegador / Browser**, **Terminal** e **Arquivos / Files**, com
ícones de 44 pixels. Os botões à direita do separador mostram as janelas abertas;
a linha inferior destaca o aplicativo e sua janela ativa. O fundo arredondado
usa o pixmap do desktop para transparência sem compositor.

Navegador abre o mesmo perfil privado usado pelas ferramentas do bot. Um novo
clique restaura e foca a janela existente, inclusive quando minimizada. Ao devolver
o controle, o bot encontra as abas e a sessão que a pessoa deixou abertas.
A abertura pelo dock e pela automação compartilha um lock privado para evitar
limpeza de arquivos de singleton durante uma inicialização concorrente.

O socket público continua aceitando apenas nomes fixos: `terminal`, `files` e
`chrome`, sem argumentos ou URLs. O broker do navegador usa UID 1001; um processo
separado, UID 1000, recebe somente os pedidos de Terminal e Arquivos por um socket
herdado. Ambos descartam privilégios antes de atender pedidos. A credencial X
confiável, o perfil e a porta de depuração continuam inacessíveis ao usuário do
terminal; os aplicativos do agente mantêm a autorização X não confiável.
