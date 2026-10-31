# QA da integração de onboarding — rodada 1

Validação de #1202, #1203, #1207, #1209 e #1216. Issue de acompanhamento: #1219.
Esta rodada registra seis achados e não altera código de produto ou testes.

## Escopo e limites

A integração foi montada sobre `be61e6418`, no commit `6cc2dda86`, com as cinco versões dos PRs. Os conflitos triviais preservaram os testes de histórico estabilizados na main e as melhorias posteriores de importação. Nenhuma correção de produto foi feita durante o QA.

As telas 01–15 e A–D do desenho aprovado foram abertas e estudadas. A exploração usou uma janela de navegador no display X, com captura após cada ação, em português. Foram usados somente agentes, notas, rotinas e pessoas fictícios.

O aplicativo desktop não estava disponível. As telas nativas 01–03 usaram o harness existente com respostas sintéticas de inicialização e descoberta. Da etapa Workspace em diante, as APIs de fontes, prévia, importação, bots, canais e mensagens usaram um servidor descartável real. O pareamento permaneceu obrigatório: a opção antiga de desativá-lo é ignorada pelo servidor.

O navegador compartilhado usou o harness existente com duas pessoas e transporte sintético compartilhado; a página e o controle eram fictícios. Isso verifica a apresentação e a propagação visual, sem comprovar autorização entre dispositivos reais ou interação com um site externo. A linha de pensamento usou os quatro cenários existentes de DM/canal, agrupados e separados. O aviso de histórico com HTTP 503 usou o harness existente; a parada e a reconexão do servidor foram verificadas separadamente na aplicação real.

## Achados

| ID | Severidade | Etapa | Reprodução e impacto | Correção sugerida |
| --- | --- | --- | --- | --- |
| F1 | P1 | Importação concluída | Importar, avançar para Computador e voltar às fontes não oferece Desfazer. A API de undo funciona e remove o bot da lista visível, mas uma pessoa não técnica não tem esse caminho. | Expor Desfazer por importação e preservar a referência ao avançar/voltar. |
| F2 | P1 | Agentes → primeira tarefa | Sem programa/login pronto, é possível concluir e enviar a primeira tarefa. A mensagem fica no histórico, mas o bot falha por programa ausente. | Verificar o agente escolhido antes do envio; oferecer conexão/instalação ou rascunho com explicação. |
| F3 | P2 | Time | Sem endereço público HTTPS, Enviar convite só revela o requisito após preencher o formulário. A orientação remete a preferências fora do onboarding. | Validar o requisito antes de oferecer a ação; configurar ali ou explicar e permitir pular. |
| F4 | P2 | Prévia e painel ao vivo | O mesmo agente apresenta identidades de touro/cores distintas na revisão, no painel e no bot criado. | Preservar uma identidade visual estável da prévia à criação. |
| F5 | P2 | Agentes e IA | Com quatro agentes em 1440×1000, formulários completos empilhados ocupam várias alturas de tela e deixam Continuar distante. O desenho aprovado usa linhas compactas. | Usar linhas compactas e abrir detalhes de conexão por agente. |
| F6 | P1 | Fluidez | Os dois cenários de orçamento de produção falharam; os números estão abaixo. A execução teve atividade concorrente e não estabelece causalidade nem regressão da main. | Repetir em condições controladas e perfilar/corrigir os custos confirmados antes de aprovar o orçamento. |

## O que funcionou

- Nome, contexto, seleção de temas, progresso e painel ao vivo acompanharam a navegação. Ler o site explica que a leitura será feita junto com a primeira tarefa.
- A fonte detectada trouxe três skills, duas memórias e apenas o nome de uma integração. A prévia contou um segredo excluído. A seleção de memórias pôde ser desmarcada.
- A pasta escolhida trouxe uma rotina; o pedido de exportação foi copiado e a resposta JSON fictícia foi colada, revisada e importada.
- As duas rotinas importadas ficaram com `enabled = 0`. Nenhuma rotina da origem executou. Os três arquivos de skills, as duas notas e o arquivo de rotinas da origem permaneceram presentes.
- O undo pela API respondeu HTTP 200, informou um bot removido e o bot original desapareceu de `GET /bots`.
- Um avatar apareceu na linha ativa em DM/canal, com e sem agrupamento. Os pontos permaneceram estáticos com movimento reduzido. Os casos sem metadados completos do bot usam a identidade padrão do harness; isso não valida a identidade de todos os estados reais.
- No navegador, espera → assumir → devolver e assumir pela página → cancelar preservaram a página para solicitante e observador. O observador viu o nome de quem controlava. Em 390 px, os controles permaneceram acessíveis, sem transbordamento horizontal.
- Ao parar o servidor real, as mensagens carregadas continuaram visíveis. O aviso explicou a indisponibilidade e a reconexão automática recuperou a conexão após reiniciar o servidor.
- O aviso de histórico apresentou código sem expandir, Detalhes e Tentar de novo como botões. Após liberar a leitura sintética e tentar novamente, a mensagem reapareceu.
- O segredo fictício não apareceu nas respostas observadas, UI, logs ou nos 25 arquivos inspecionados do diretório de dados. O valor ficou somente no arquivo secreto da origem.

## Medições e verificações

`PerformanceObserver` coletou tarefas longas, event timing e layout shift. A medida de clique até pintura usa duas chamadas de `requestAnimationFrame` como aproximação. O event timing foi registrado separadamente, agrupado por interação. Não são medidas de duração total das chamadas de API.

| Cenário de produção | Interações | Clique → pintura p95 | Evento → pintura p95 | Tarefas longas | Máximo | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Onboarding 1440 px | 14 | 182,9 ms | 288 ms | 28 | 191 ms | 0,00129 |
| Onboarding 390 px | 14 | 199,6 ms | 304 ms | 29 | 191 ms | 0 |

Os dois testes novos falharam primeiro na ausência de tarefas longas; os percentis também excederam 100 ms. A main usada como base não contém esse guia/teste novo, portanto não se afirma regressão de um teste preexistente. Atividade concorrente limita a atribuição dos custos observados.

A exploração manual de produção registrou 28 cliques: p95 da aproximação por pintura de 212,5 ms e event timing p95 de 720 ms. Antes do envio final, houve 21 tarefas longas (máximo 122 ms) e CLS 0,03780, incluindo expansão assíncrona do login. Os cinco cliques coletados no navegador compartilhado não constituem uma amostra estatística estável; os resultados brutos dessa exploração ficam separados dos testes de orçamento. O detalhamento por transição está em [transitions.json](transitions.json), e as duas medições de teste estão em [fluidity.json](fluidity.json).

| Verificação | Resultado |
| --- | --- |
| Instalação com lockfile congelado | Executada nas duas cópias de trabalho, com dependências próprias. |
| `bunx tsc --noEmit -p tsconfig.base.json` | Passou na integração. |
| `bunx biome check` nos arquivos de implementação selecionados | Passou: 29 arquivos, sem alterações. |
| `bunx vitest run test/onboarding-guide.test.tsx test/onboarding-guide-timing.test.ts` | Dois arquivos aprovados por resultado reutilizado; não foram reexecutados nesta rodada. |
| `bunx playwright test test/e2e/onboarding-guide.spec.ts` | 7 cenários passaram; 2 falharam no orçamento de produção, em 1440 e 390 px. |
| `bun --cwd ui build` | Passou; avisos de tamanho de chunks permaneceram. |
| Sidecar da integração | Não executado nesta rodada; 42 arquivos estavam selecionados. Este relatório não declara aprovação dessa suíte. |

Uma execução ampla inicial foi interrompida sem conclusão e não conta como aprovação; a tabela registra a seleção focada concluída.

Nenhum teste foi adicionado: esta rodada foi explicitamente de validação, sem corrigir código. As evidências visuais são anexadas ao PR deste relatório e aos PRs relacionados. Os achados continuam abertos para as respectivas correções.
