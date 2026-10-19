# Modo servidor no desktop

O modo servidor é uma escolha explícita em **Configurações → Avançado → Usar um servidor touri**. Os bots, conversas, arquivos, logins e execuções pertencem ao servidor selecionado. O desktop mostra a interface e mantém as funções nativas. Voltar ao modo local reinicia o aplicativo com o ambiente local anterior; não copia nem apaga os dados do servidor.

## Arquitetura e credenciais

A janela principal continua carregando a interface incluída na instalação. O shell abre um relay HTTP/WebSocket em uma porta aleatória de loopback e só então fornece o endpoint para a interface. No ramo de inicialização do modo servidor, o shell não cria o sidecar local. Nenhuma execução de bot local é necessária para conectar.

Essa escolha mantém o código executável da interface vinculado à versão instalada e permite atualizar o desktop pelo fluxo habitual. O servidor não injeta scripts na janela com permissões nativas. A CSP continua aceitando conexões de loopback, sem autorizar origens remotas arbitrárias.

O pareamento nativo envia o código de uso único para `POST /pair` com `client: true`, verifica a sessão e a versão do esquema e guarda o token de dispositivo no cofre seguro do sistema. O arquivo `server-mode.json` contém somente modo e origem do servidor. O token remoto não entra no JavaScript, em armazenamento web, URLs ou logs. O endpoint fornecido à interface contém outra credencial, aleatória e válida somente para o relay daquela execução.

O relay aceita somente rotas da API, autentica o chamador local e valida a origem. Remove cookies, origem e autenticação recebidos antes de acrescentar a credencial remota na solicitação ao servidor. Conexões remotas exigem HTTPS válido e não seguem redirecionamentos. Tickets WebSocket locais são de uso único, vinculados ao caminho e expiram em 15 segundos; a conexão remota recebe seu próprio ticket. A rede de loopback não é considerada autenticação.

A ponte verifica a conexão WebSocket remota a cada 15 segundos. Se não receber nenhum frame, incluindo a resposta de controle, por 45 segundos, fecha o canal local para a interface indicar a desconexão e tentar novamente. Esperas de envio e encerramento são limitadas; uma conexão TCP parada não mantém o estado de conectado indefinidamente.

Uma configuração inválida, um cofre bloqueado ou um servidor indisponível não inicia o ambiente local silenciosamente. A recuperação oferece tentar novamente, novo pareamento ou retorno explícito ao modo local. O código de pareamento é apagado do formulário após a tentativa. Para invalidar definitivamente um desktop, revogue seu dispositivo no servidor; trocar o modo do aplicativo não equivale a revogar o dispositivo.

## Encerramento gradual de `touri serve`

Ao receber SIGTERM ou SIGINT, `touri serve` para de iniciar turnos, mantém os turnos ativos em execução até o prazo configurado e deixa novas mensagens na fila durável para o próximo início. O prazo padrão é 60 segundos; configure outro valor entre 1 e 600 com `--drain-timeout <segundos>`. Após o prazo, os turnos ainda ativos são persistidos como interrompidos e seguem as regras existentes de recuperação segura. Um segundo SIGTERM ou SIGINT pula a espera e inicia imediatamente essa interrupção, com registro no log. O limite absoluto continua sendo o prazo original mais 20 segundos, inclusive se um provedor não responder. Turnos de grupo ainda na fila permanecem duráveis e são executados em ordem ao reiniciar.

Para systemd, `TimeoutStopSec` deve superar o prazo de encerramento em pelo menos 30 segundos. Use `KillMode=mixed`: o systemd sinaliza primeiro apenas o processo principal, permitindo que touri finalize seus provedores; se o limite do systemd expirar, ele encerra o grupo de processos.

```ini
ExecStart=/usr/local/bin/touri serve --drain-timeout 60
KillMode=mixed
TimeoutStopSec=90
```

## Graceful shutdown for `touri serve`

On SIGTERM or SIGINT, `touri serve` stops starting turns, lets active turns run until the configured deadline, and leaves new messages in the durable queue for the next start. The default deadline is 60 seconds; set a value from 1 to 600 with `--drain-timeout <seconds>`. At the deadline, remaining active turns are persisted as interrupted and use the existing safe recovery rules. A second SIGTERM or SIGINT skips the wait and starts that interruption immediately, with a log entry. The absolute backstop remains the original deadline plus 20 seconds, including when a provider does not respond. Group turns still waiting remain durable and run in order after restart.

For systemd, set `TimeoutStopSec` to at least 30 seconds beyond the drain deadline. Use `KillMode=mixed`: systemd first signals only the main process so touri can finish its providers; if the systemd timeout expires, it terminates the process group.

```ini
ExecStart=/usr/local/bin/touri serve --drain-timeout 60
KillMode=mixed
TimeoutStopSec=90
```

## Verificação automatizada

Execute os checks somente pelo gate de evidências da instalação de desenvolvimento. A suíte `e2e` inclui `ui/test/e2e/server-mode.spec.ts`; o próprio fixture constrói a interface dentro da execução serializada do gate.

Nesta entrega, o gate informou que os checks estão pausados pelo responsável. O retorno `skipped` significa **não executado**, mesmo com código de saída zero. Typecheck, formatação, testes, build e compilação Rust ainda precisam de validação em revisão/CI. A suíte Rust de CI cobre os testes de inicialização, relay e links nativos.

O teste cria um diretório temporário do sistema, escolhe uma porta privada de loopback e inicia um processo real `touri serve` com `--data-dir` e `--ui-dir` explícitos. O comando `touri pair` cria códigos no banco real desse processo. A interface compilada exercita conectar, testar conexão, voltar ao modo local, rejeição de reutilização do código, atualização recebida ao vivo e recuperação após uma lacuna maior que o limite de replay de 2 MiB. Nesse último caso, verifica o frame real de ressincronização e a recarga do estado por REST. O fixture encerra somente seu processo e remove seu diretório ao finalizar.

O navegador substitui somente o IPC e o relay nativo por um adaptador de teste. O token de dispositivo fica na memória desse adaptador; todas as APIs, tickets e eventos vêm do servidor real. O fixture usa a exceção de HTTP para loopback explícito (`127.0.0.1`, `localhost` ou `[::1]`); origens externas exigem HTTPS. Esse teste não verifica TLS, o cofre do sistema, a janela nativa, ausência de subprocessos no desktop ou consumo de memória no macOS. Os testes Rust cobrem as decisões de inicialização e as regras do relay; a validação abaixo completa a evidência.

Quando o teste e2e puder executar, ele gerará as capturas abaixo usando apenas nomes e dados sintéticos. Elas ainda estão pendentes nesta entrega:

- `docs/evidence/server-mode-settings.png`: configuração e teste da conexão.
- `docs/evidence/server-mode-offline.png`: estado sem conexão, com o estado existente preservado.

## QA manual no macOS

Use uma conta de teste do sistema e uma compilação identificada pelo commit. Não modifique os dados de uma instalação de uso diário. Use um servidor separado, dados descartáveis e uma origem HTTPS com certificado confiável. O processo do servidor deve executar em outro computador, para a medição do desktop não incluir seu consumo.

Para preparar os dados descartáveis no computador do servidor, a partir do checkout compilado:

```sh
TOURI_QA_DATA=$(mktemp -d -t touri-server-mode-XXXXXXXX)
touri serve --host 127.0.0.1 --port 18795 --data-dir "$TOURI_QA_DATA" --ui-dir ui/dist --trust-proxy
```

Configure o proxy HTTPS de teste somente para esse processo, com os cabeçalhos de origem encaminhada esperados. Em outro terminal, gere um código com `touri pair --data-dir "$TOURI_QA_DATA"`. Use a origem HTTPS de teste no desktop. Não cole tokens em comandos, capturas ou relatórios. Ao terminar, encerre o processo descartável, remova a configuração do proxy de teste e apague somente o diretório apontado por `TOURI_QA_DATA`.

1. **Base local.** Inicie o desktop no modo local. Registre versão do sistema, arquitetura, commit e quantidade de bots. Deixe todos os bots ociosos, sem máquinas isoladas, previews ou telas abertas. Aguarde dois minutos. Na ferramenta de monitoramento de processos do sistema, identifique o shell touri, todos os processos de conteúdo web pertencentes à janela e o sidecar local. Anote seus PIDs para conferir a filiação, sem publicar nomes de usuário ou caminhos pessoais.
2. **Pareamento.** Abra Configurações → Avançado, informe origem e código e conecte. Confira o aviso sobre onde ficam os dados e a indisponibilidade de recursos do Mac. O aplicativo deve reiniciar, mostrar somente os bots do servidor e confirmar a conexão em **Testar conexão**. Reutilizar o mesmo código deve falhar. Reinicie mais uma vez sem gerar código: a conexão deve continuar funcionando pelo cofre seguro.
3. **Ausência do runtime local.** Compare os processos após o reinício. O sidecar anterior deve ter encerrado. Não deve existir novo sidecar filho do desktop, nem processo de provedor ou máquina isolada iniciado por ele. Faça essa verificação novamente após criar um bot no servidor e enviar uma mensagem. A execução deve aparecer apenas no computador do servidor.
4. **Memória ociosa.** Use a mesma janela, tema e resolução da medição local. Feche previews e telas, pare a interação e aguarde dois minutos. Registre a coluna **Memória** do shell e de cada processo de conteúdo web associado; sidecar deve ser **ausente / 0 MB**. Tire três amostras separadas por 30 segundos e use o maior total observado. Some os valores da mesma amostra; não misture o menor valor de processos em instantes diferentes. Conte processos auxiliares exclusivos do desktop e indique quais foram incluídos.
5. **Meta.** O total de shell + conteúdo web + sidecar + auxiliares exclusivos deve ser **≤ 150 MB em repouso**. Registre os números mesmo se excederem a meta. Uma build de desenvolvimento ou outra métrica de memória deve ser identificada como tal; não substitui o resultado da build distribuída. Repita após dez minutos ociosos e após três ciclos de desconexão/reconexão para detectar crescimento contínuo.
6. **Avisos e badge.** Permita avisos nativos, deixe o desktop fora de foco e provoque no servidor uma solicitação de aprovação ou pergunta. Confira um aviso e a contagem correta no dock. Clique no aviso: deve abrir a conversa correspondente do servidor. Resolva a pendência e confira a redução da contagem. Reconectar não deve duplicar avisos antigos; negar a permissão deve produzir orientação visível nas configurações de avisos.
7. **Links e janela.** Abra `touri://open?bot=<id>&thread=<id>` com IDs dos dados de teste, tanto com o aplicativo aberto quanto encerrado. A conversa deve pertencer ao servidor configurado. Redimensione, mova e reabra a janela: o estado deve ser preservado. Um ID inexistente não deve selecionar uma conversa local por coincidência.
8. **Recursos do Mac.** Confira que seleção de pastas locais, controle da tela do Mac e navegador pessoal estão ocultos ou explicados como indisponíveis. Pastas e computadores do servidor continuam identificados como remotos. Previews em loopback orientam abrir o navegador do servidor; não podem abrir por engano um serviço local do Mac. Cancelar uma ação ou usar o comando de parada deve atingir o servidor escolhido.
9. **Recuperação.** Interrompa somente a conectividade do desktop de teste. A interface deve mostrar o estado sem conexão, preservar conversas e recuperar o estado ao restaurar a rede. Gere atividade suficiente no servidor para ultrapassar o limite de replay: a retomada deve carregar um snapshot, sem deixar a interface presa no histórico. Teste também reinício do servidor, suspensão e retorno do Mac, dispositivo revogado, certificado inválido, versão incompatível e cofre bloqueado. Esses casos não podem iniciar bots locais automaticamente. As ações já enviadas não devem ser executadas novamente durante a recuperação.
10. **Voltar ao local.** Clique **Voltar ao modo local** inclusive quando o servidor estiver indisponível. Após o reinício, o sidecar local deve voltar e os dados locais anteriores devem continuar disponíveis. Rascunhos, seleção de conversa e mensagens pendentes de uma origem não devem aparecer ou ser enviados para outra. Os dados do servidor devem permanecer intactos.

## Registro de evidências

Não há medição válida de RAM do desktop macOS feita em Linux. Preencha esta tabela durante a QA e copie os resultados para o PR; **pendente** significa que a meta ainda não foi verificada.

| Modo e instante | Shell (MB) | Conteúdo web (MB) | Sidecar (MB) | Auxiliares (MB) | Total (MB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local, maior amostra após 2 min | pendente | pendente | pendente | pendente | pendente |
| Servidor, maior amostra após 2 min | pendente | pendente | ausente / 0 | pendente | pendente |
| Servidor, após 10 min | pendente | pendente | ausente / 0 | pendente | pendente |
| Servidor, após 3 reconexões | pendente | pendente | ausente / 0 | pendente | pendente |

Anexe capturas dos processos e da conexão com apenas dados sintéticos. Registre aprovação/reprovação da meta, comportamento das notificações, links, recuperação, ausência do runtime local e retorno ao modo local. A escolha remota explícita serve às promessas de controle, isolamento e uma interface nativa simples; a localização dos dados deve continuar clara.
