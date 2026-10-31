# Onboarding: terceira rodada de QA

Três achados permanecem: identificação de importação anterior, erro genérico após parada do servidor e orçamento de fluidez. A exploração não alterou código de produto. Os defeitos de produto continuam acompanhados em #1227.

## Integração e limites

Base `87027189e`; integração local `5007fd37f`. #1202 e #1216 já estavam incorporados à main; as branches remotas correspondentes não existiam mais. As pontas de `feat/ob-ui`, `feat/ob-import` e `feat/ob-fix-history` foram integradas. Conflitos triviais de traduções e testes adicionados foram resolvidos preservando os dois lados.

`feat/ob-fix-2-ux` (#1235) não está incluída: houve conflitos semânticos em cinco arquivos, incluindo recuperação de histórico, estado da prévia e undo. A mesclagem foi abortada conforme a instrução de resolver somente conflitos triviais. Estes resultados não avaliam essa branch isoladamente. A integração completa das seis branches continua limitada por esses conflitos.

A execução abriu o design aprovado no navegador e comparou as telas 01–15 e A–D. Usou navegador com janela no display X, ações de mouse/teclado decididas após observar as telas e captura depois de cada ação. Não é uma aprovação visual do aplicativo nativo empacotado nem uma comparação causal de desempenho com a main.

Foi iniciado `bun run touri serve` com diretório descartável e HOME fictício. Como `--no-pair` foi aposentado, esse servidor exige pareamento. O fluxo local completo usou o adaptador nativo existente em `ui/test/e2e/onboarding-server.ts` e os componentes compilados em produção. Importação, undo, canais, mensagens e recuperação usaram APIs reais desse runtime. Descoberta de rede e entregas são simuladas pelo adaptador; nenhum convite ou e-mail foi enviado.

O HOME tinha CLAUDE.md, três skills, duas memórias de projeto, um nome de integração, credenciais claramente fictícias e outra pasta com uma rotina. Após verificar a falta real de login e a preservação do texto, somente a resposta de prontidão da conta foi substituída para prosseguir. A CLI também era fictícia: nenhuma chamada paga foi feita. A primeira tarefa chegou ao geral e sua resposta foi persistida.

O navegador compartilhado foi visto por duas pessoas fictícias no harness existente, com BroadcastChannel, transporte e página simulados. Isso valida a apresentação e os controles; não valida autorização real entre duas sessões autenticadas nem atualização visual de um site real.

## Telas e observações

| Referência | Quadros | Resultado |
| --- | --- | --- |
| 01 | 004 | Boas-vindas legível; ação Começar funciona. |
| 02 | 005 | Destino local disponível; oferta remota adicional fora do escopo desta rodada. |
| 03 | 006–008 | Busca exibe computador local e servidor fictício; voltar funciona. Descoberta de rede simulada pelo adaptador existente. |
| 04 | 010–011 | Nome atualiza o workspace ao vivo. |
| 05 | 012–014 | Contexto e Suporte aparecem na prévia. |
| 06 | 015–021 | Fonte local detectada; seletor de pasta lê a pasta fictícia. |
| 07–08 | 029–035 | Exportação via pedido e JSON validada. Uma tentativa incompleta da fixture foi rejeitada; o JSON completo do formato exibido foi aceito. |
| 09 | 022–024 | Três skills, duas memórias, integração pelo nome e dois segredos excluídos. Nome repetido desabilita importar; nome revisado libera. |
| 10 | 025–028,036–037 | Importação e undo seletivo funcionam; nova importação perde o nome da ação anterior e omite o agente mantido da prévia. |
| 11 | 038–040 | Navegador opt-in, controles disponíveis; indisponibilidade de máquina separada explicada. |
| 12 | 041–042,047–048 | Sem login pronto, a tarefa retorna à conexão da conta e conserva o texto. Rótulos dos provedores ocultados nas cópias públicas. |
| 13 | 043,049 | Time acessível ao dono nativo. Ausência de endereço HTTPS é explicada; nenhum convite enviado. |
| 14 | 044–051 | Tarefa preservada após falta de login. Prontidão substituída por resposta fictícia apenas para continuar; envio e leitura usam APIs reais. |
| 15 | 052–054 | Tarefa enviada ao geral e resposta de CLI fictícia persistida. Identificação do sistema ocultada no primeiro quadro público. |
| A | 058–061 | Antes do primeiro texto, Preparando a resposta tem um único avatar na coluna; stop real disponível. |
| B–C | 068–082 | Duas abas com pessoas fictícias veem a página em espera, controle e devolução. Solicitante tem controles; outro membro acompanha. 1440/390 px, zero overflow horizontal. Transporte e identidades sintéticos. |
| D | 062–067 | Parada real dos runtimes preserva mensagens, mas troca de canal mostra erro genérico global. Reconexão automática restaura sem recarregar. |

## Achados

P2 | ob-ui | 10 Importando após desfazer uma fonte e importar JSON | O agente mantido da primeira fonte some da prévia durante a nova importação e seu botão fica apenas Desfazer importação de, sem nome; o agente reaparece em Agentes e IA | Preservar os metadados das importações concluídas ao trocar a prévia, mostrar todos os agentes mantidos e identificar cada ação de desfazer.
P2 | ob-fix-history | Servidor parado / abrir suporte e retornar a geral no adaptador nativo | As mensagens salvas permanecem, mas a falha ao listar conversas ainda produz Não foi possível concluir a solicitação / Verificar ambiente e TOURI-E1000, sem aviso de histórico e Tentar de novo dentro da conversa; a reconexão automática recupera após reiniciar | Tratar a recusa e a indisponibilidade do transporte na seleção/listagem de conversas, preservando histórico e oferecendo retry no contexto. Revalidar com a branch adicional após resolver seus conflitos semânticos.
P1 | ob-ui | Fluidez da configuração, seletor de pasta e recuperação | Orçamento não aprovado: 27 cliques do onboarding com p95 159,7 ms; abrir seletor 159,7 ms, expandir caminho 164,2 ms e abrir pasta 153,3 ms. Houve uma tarefa longa de 52 ms. Histórico teve CLS 0,13606; navegador desktop teve uma tarefa de 58 ms e CLS 0,01617 | Perfilar seletor e inserção dos avisos, reservar espaço de layout e validar p95 <100 ms, tarefas <50 ms e CLS próximo de zero em condição controlada; não atribuir regressão à main com esta amostra exploratória.

## Medições

| Amostra | Cliques | Clique → pintura p95 | Evento p95 | Tarefas longas / máximo | CLS |
| --- | ---: | ---: | ---: | ---: | ---: |
| onboarding-runtime-metrics | 27 | 159.7 ms | 160 ms | 1 / 52 ms | 0.01118 |
| history-runtime-metrics | 3 | 55.6 ms | 136 ms | 1 / 121 ms | 0.13606 |
| browser-desktop-requester | 2 | 63.2 ms | 144 ms | 1 / 58 ms | 0.01617 |
| browser-all-requester | 4 | 63.2 ms | 144 ms | 1 / 58 ms | 0.01617 |
| browser-all-member | 0 | NA | NA | 2 / 74 ms | 0.01196 |

Cada clique registra dois callbacks requestAnimationFrame, event timing e tarefas/deslocamentos nos 500 ms seguintes nos JSONs. Percentil nearest rank. CLS é a maior janela de até cinco segundos com intervalo máximo de um segundo entre deslocamentos, excluindo interação recente; a soma simples também está disponível e não é apresentada como CLS.

Os cliques mais lentos foram abrir o seletor de pasta (159,7 ms), expandir caminho (164,2 ms) e abrir pasta (153,3 ms). A tarefa de 52 ms do onboarding ocorreu na inicialização, antes do primeiro clique. O máximo de 58 ms no navegador ocorreu no início do handoff; o CLS do navegador inclui montagem inicial. O registro do histórico também inclui a sessão e as respostas anteriores à parada. As abas em segundo plano podem atrasar callbacks; nenhuma latência de clique é atribuída à aba observadora, que não recebeu cliques.

A amostra foi exploratória, com gravação de tela a oito quadros por segundo e outras atividades concorrentes. Não houve gravação por aba. Os números não demonstram uma regressão contra a main nem aprovação de desempenho em condição controlada. O orçamento solicitado continua sem aprovação.

## Segredo fictício

Zero ocorrências nas saídas observadas da UI/API, nos logs e nos dados dos bots: 176 respostas de API observadas durante a exploração, sete respostas adicionais auditadas e 29 arquivos dos runtimes examinados. Os arquivos-fonte da fixture continham o marcador de propósito e ficaram fora da busca nos dados importados. Prévia: três skills, duas memórias, dois segredos excluídos; a integração trouxe somente seu nome. Undo removeu Rotinas demo e Resumo diário; Resumo semanal permaneceu pausada.

## Verificação

- `bun install --frozen-lockfile`: executado nos dois worktrees, com dependências próprias.
- `bun --cwd ui build`: passou na integração; a compilação dos três harnesses também passou.
- `bunx tsc --noEmit -p tsconfig.base.json`: passou na integração.
- `bunx biome check`: passou nos 24 arquivos selecionados da integração.
- `bunx vitest run`: quatro arquivos focados passaram: onboarding-guide, history-cache-regressions, history-failure e service-connection. A seleção ampla foi interrompida; não é apresentada como aprovação completa.
- `bunx playwright test`: quatro arquivos selecionados; execução encerrada por término do processo durante a compilação do primeiro cenário. Nenhuma aprovação de e2e automatizado nesta rodada; a exploração manual acima é evidência separada.
- Sidecar: 384 arquivos selecionados; execução local omitida conforme o limite de seleção. Não há aprovação sidecar desta integração nem alegação de CI verde.
- `git diff --check`: passou.

Os anexos usam apenas exemplos fictícios. Os rótulos de conta de IA e a identificação herdada do sistema foram explicitamente ocultados em cinco quadros; as observações funcionais permanecem visíveis. Os vídeos publicados são recortes da gravação de tela, em GIF, a duas vezes a velocidade. Não incluem as telas com rótulos ocultados. Todas as capturas de evidência publicáveis desta rodada são anexadas ao PR de documentação; os conjuntos correspondentes também são anexados aos PRs de produto relacionados.

## Event loop e segurança

Este diff contém somente Markdown/JSON estáticos. Não adiciona trabalho a handlers, streaming, turnos, banco ou renderização. A auditoria dinâmica do segredo é limitada aos fluxos exercitados; não substitui revisão de segurança das implementações. A revisão completa, incluindo gitleaks 8.30.1 e um item por ID de SECURITY_REVIEW.md, está no corpo do PR.
