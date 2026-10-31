# Onboarding: segunda rodada visual

Esta rodada encontrou cinco lacunas na integração. Nenhum código de produto foi corrigido.
A primeira rodada permanece em `../onboarding-round-1/` como registro histórico.

A base foi `fb92bcd21`, com os PRs #1202, #1203, #1207, #1209 e #1216 já integrados,
e a correção complementar de navegador #1222. A branch de importação foi integrada em
`15c2c2c7e`, incluindo o tratamento de rotinas incompatíveis que ainda estava nela.
Não havia branches remotas com o prefixo de correções da primeira rodada.

## Como foi verificado

Chromium com janela em um display X, mouse/teclado via Playwright e captura após cada ação.
As telas aprovadas 01–15 e A–D foram abertas no navegador e estudadas antes da exploração.
Somente dados fictícios foram usados. A gravação contínua da tela foi preservada; os anexos
públicos são recortes curtos revisados, sem credenciais ou caminhos pessoais.

- Entrada, escolha de computador, endereço e pedido de pareamento foram percorridos visualmente.
  O servidor descartável manteve autenticação: `--no-pair` é aposentado.
- O onboarding de desktop usou o adaptador nativo existente de testes e um runtime real isolado.
  Importação detectada, pasta, JSON, revisão, aplicação e desfazer usaram APIs reais.
- A pasta fictícia continha instruções, três skills, duas notas de memória, um nome de integração
  e um arquivo de segredo fictício. As notas de memória foram inicialmente colocadas fora do
  formato de projetos aceito; depois da correção da fixture, a prévia HTTP mostrou três skills
  e duas memórias. Esse ajuste de fixture não é um achado do produto.
- O bloqueio por nomes repetidos foi reproduzido duas vezes. O servidor respondeu HTTP 400 em
  `POST /groups`, com `memberIds` inválido por nomes repetidos. Para continuar a exploração,
  somente os bots fictícios foram renomeados pela API.
- Sem conta pronta, enviar a tarefa voltou à configuração de agentes e preservou o texto.
  Para as etapas seguintes, o estado pronto do provedor foi simulado e a execução usou o CLI
  fictício já existente no repositório, sem chamadas pagas a modelos.
- O token nativo de desktop não forneceu pessoa às rotas de equipe/conversas: `/invites` recusou
  com 403 e `/groups/:id/threads` com 404. Depois de parear um dono fictício, a mesma conversa
  funcionou. A mensagem chegou ao `#geral`; a linha ativa exibiu um único avatar de touro.
- A etapa Time, seu diálogo e a tela Pronto também foram inspecionados com o adaptador HTTP
  sintético existente. Nenhum convite ou e-mail foi enviado. Isso não aprova a autorização real
  de equipe, que permaneceu bloqueada no caminho nativo descrito no achado.
- Espera → assumir → devolver foram percorridos por duas pessoas fictícias no harness de
  navegador compartilhado existente, compilado em produção. Ambas viram a página durante
  todo o controle. Em 390 px, assumir e cancelar mantiveram a ação de devolver acessível.
  Esse transporte sintético não é teste de autorização real entre duas pessoas.
- O runtime foi parado durante a sessão. As mensagens carregadas permaneceram visíveis.
  Abrir outro canal expôs o aviso global genérico descrito nos achados. O harness específico
  de recusa 503 demonstrou aviso dentro da conversa, detalhes, nova tentativa ainda falhando
  e recuperação após liberar a resposta. Esses dois caminhos são evidências distintas.

## Achados

[findings.md](findings.md) contém as cinco linhas em formato severidade, frente, lugar, lacuna e ação.

## Medições

`metrics.json` contém cada clique observado e o próximo quadro estimado por dois callbacks
`requestAnimationFrame`, além de Event Timing, tarefas longas e deslocamentos de layout.
Os percentis usam nearest rank. As tarefas longas incluem inicialização e toda a janela de coleta.

| Cenário de produção | Cliques | Clique → pintura p95 | Evento p95 | Tarefas longas / máximo | CLS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Onboarding, runtime real | 27 | 689,4 ms | 2112 ms | 125 / 308 ms | 0,04160 |
| Onboarding sintético, sem vídeo por aba | 11 | 3383,4 ms | 3792 ms | 26 / 499 ms | 0,00854 |
| Navegador sintético, desktop | 2 | 1102,7 ms | 2688 ms | 21 / 1213 ms | 0,01617 |
| Navegador sintético, desktop + telefone | 4 | 1102,7 ms | 2688 ms | 38 / 1213 ms | 0,01617 |

São amostras observacionais pequenas, com gravação de tela e atividade concorrente. Houve pausas
visíveis e o orçamento não foi aprovado. Não há comparação causal com a main. Tirar a gravação
por aba não tornou a segunda amostra uma medição controlada. É preciso repetir e perfilar antes
de atribuir o custo a uma implementação.

## Segredo fictício

`secret-audit.json`: zero ocorrências do valor na UI observada, nas quatro respostas da auditoria,
nos logs e nos 38 arquivos de dados examinados. A prévia contou um segredo excluído; o nome da
integração veio sem configuração executável. As rotinas permaneceram pausadas. A leitura das duas
notas de memória foi confirmada pela API na fixture com o formato de projetos correto.

## Validação e limites

- `bun install --frozen-lockfile`: executado em cada worktree, com dependências próprias.
- `bun --cwd ui build`: passou na integração; o build de harnesses de navegador/histórico também passou.
- `bunx tsc --noEmit -p tsconfig.base.json`: passou na integração e no relatório.
- `bunx biome check`: passou para os arquivos selecionados da integração; resultado documental detalhado no PR.
- A seleção de sidecar da integração incluiu 36 arquivos. A execução foi interrompida sem resultado
  completo; não há aprovação dessa suíte nesta rodada. Nenhuma falha de asserção foi atribuída ao diff.
- A seleção Vitest da integração não encontrou arquivos afetados. A seleção do relatório documental
  não encontrou arquivos Vitest ou de navegador afetados. A exploração visual não foi apresentada
  como execução das suítes automatizadas de navegador.

## Event loop

O diff deste relatório contém apenas documentos e JSON. Não adiciona trabalho de execução.
As medições acima reprovam o orçamento observado; não constituem aprovação de desempenho.

## Security review

O escopo desta revisão é a documentação e seus anexos, sem substituir as revisões de implementação.
A auditoria do segredo e a inspeção visual dos quadros são evidências complementares.
O PR contém a tabela completa de SECURITY_REVIEW.md, incluindo a varredura gitleaks 8.30.1.

VISION: promessas 1 (dados locais), 3 (histórico), 4 (controle explícito) e 7 (clareza e fluidez).
