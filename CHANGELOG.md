# Changelog

## 0.3.0

Changes since [v0.2.0](https://github.com/touri-ai/touri/releases/tag/v0.2.0).
Downloads and installation warnings: [README](README.md#install-github-releases).

### Português

#### Modo servidor e desempenho

- Modo servidor pareado no aplicativo desktop, com reconexão e recuperação de falhas de inicialização (#213, #274, #320).
- Menos gravações e crescimento do histórico durante respostas; retenção e recuperação em lotes limitados para manter o envio de mensagens responsivo (#210, #211, #270, #278, #385).
- Indicadores de atraso do event loop e requisições lentas; processos e respostas de modelos por API com trabalho assíncrono limitado (#354, #381, #349).

#### Chat e UX

- Digitação e rolagem mais leves em conversas longas, com menos renderizações e alocações durante respostas (#216, #334, #367, #383).
- Resumo de atividade, diagramas nas mensagens, acesso rápido a projetos e menus mais consistentes (#182, #215, #323).
- Rotinas podem publicar em grupos; conversas de rotina são agrupadas, mostram a fila e os turnos em execução; grupos exibem progresso dos participantes (#244, #306, #337, #358, #376).
- Criação de bots guiada, preferências de notificação e horário silencioso, formulários melhores em janelas estreitas e exclusão confirmada de grupos (#309, #336, #346, #357).

#### Integrações

- Conversas com bots pelo Telegram, com ativação após salvar o token, recuperação de conversas e entrega responsiva (#255, #326, #356).
- Modelos por API com chave própria, descoberta de modelos, teste de conexão e escolha por bot; credenciais isoladas por modelo (#301, #312).
- Memória e habilidades opcionais por bot, com um serviço de memória externo opcional e revisão antes de aplicar aprendizado (#256, #257, #294, #307).

#### Confiabilidade

- Contexto preservado após reiniciar o servidor e pedidos mantidos durante recuperação precoce (#158, #258).
- Recuperação de inicialização travada, falhas no início das ferramentas e bloqueios temporários do banco de dados (#227, #350, #353).
- Tarefas interrompidas e efeitos incertos centralizados para revisão; objetivos locais continuam entre turnos dentro do orçamento (#322, #342, #359, #408).
- Rotinas preservam alterações parciais; exclusão de bots ociosos com histórico de grupo foi corrigida (#310, #325).

#### Segurança

- Permissões de pastas no Linux e em máquinas isoladas preservadas, com aprovação antes de ampliar o acesso (#162, #189, #225, #275).
- Credenciais de modelos e memória vinculadas ao destino autorizado; aprendizado respeita limites de arquivos e consentimento de revisão (#294, #307, #312).
- Guias obrigatórios de revisão de segurança e event loop, incluindo proteção de dados, segredos, isolamento e publicação (#386).

#### Windows

- Instaladores x64 `.msi` e `.exe`, produzidos pelo CI na main no artefato `touri-windows-x64`.
- Descoberta de executáveis no PATH do Windows, inicialização do sidecar sem console e encerramento limpo (#217, #226, #235).
- A interface identifica o host real e usa “computador” no Windows, inclusive em login e rotinas (#347).
- Os instaladores Windows ainda não são assinados: o SmartScreen pode exigir **Mais informações → Executar assim mesmo**. O download para macOS Apple Silicon é uma **pre-release**.

### English

#### Server mode and performance

- Paired server mode in the desktop app, with reconnection and startup recovery (#213, #274, #320).
- Fewer writes and less transcript growth during replies; bounded retention and recovery batches keep message submission responsive (#210, #211, #270, #278, #385).
- Event-loop lag and slow-request diagnostics; bounded asynchronous process work and responsive API model streams (#354, #381, #349).

#### Chat and UX

- Smoother typing and scrolling in long conversations, with fewer renders and allocations while replies stream (#216, #334, #367, #383).
- Activity summaries, diagrams in messages, quick project links and more consistent menus (#182, #215, #323).
- Routines can post to groups; routine conversations are grouped and show queues and running turns; groups show member progress (#244, #306, #337, #358, #376).
- Guided bot creation, notification preferences and quiet hours, improved narrow-window forms and confirmed group deletion (#309, #336, #346, #357).

#### Integrations

- Chat with bots through Telegram, with activation after saving the token, conversation recovery and responsive delivery (#255, #326, #356).
- API models with your own key, model discovery, connection testing and per-bot selection; credentials isolated per model (#301, #312).
- Optional per-bot memory and skills, including an optional external memory service and review before applying learned changes (#256, #257, #294, #307).

#### Reliability

- Preserved context after server restarts and preserved requests during early recovery (#158, #258).
- Recovery from stalled startup, tool startup failures and temporary database locks (#227, #350, #353).
- Interrupted tasks and uncertain effects collected for review; local goals continue across turns within their budget (#322, #342, #359, #408).
- Routine updates preserve omitted fields; idle bots with shared group history can be deleted (#310, #325).

#### Security

- Preserved Linux and isolated-machine folder permissions, with approval before access expansion (#162, #189, #225, #275).
- Model and memory credentials bound to their authorized destination; learning respects file boundaries and review consent (#294, #307, #312).
- Required security and event-loop review guides cover data, secrets, isolation and release publication (#386).

#### Windows

- x64 `.msi` and `.exe` installers, built by CI on main in the `touri-windows-x64` artifact.
- Windows PATH executable discovery, sidecar startup without a console window and clean shutdown (#217, #226, #235).
- Host-aware UI labels use “computer” on Windows, including login and routine notices (#347).
- Windows installers are still unsigned: SmartScreen may require **More info → Run anyway**. The macOS Apple Silicon download is a **pre-release**.
