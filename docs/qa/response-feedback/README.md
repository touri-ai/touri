# Evidência de resposta e espera

Base das capturas anteriores: `3635878`. Cenários em pt-BR, 1440×900 e 390×844, com o mesmo simulador e o journal real de envio. Nenhuma chamada paga foi usada.

O simulador confirma o envio após 200 ms e recebe uma saída controlada após uma espera de 4.810 ms. Os tempos abaixo foram capturados no navegador com relógio real, durante dez conversas distintas. A primeira confirmação e a atividade após o aceite foram medidas no momento da alteração do DOM. Os outros intervalos vêm do registro local da aplicação.

| Conversa | Confirmação local (ms) | Aceite → atividade (ms) | Envio → aceite (ms) | Aceite → primeiro evento (ms) | Envio → primeiro texto (ms) | Provedor → primeiro evento (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 17.5 | 14.7 | 219 | 4877 | 5113 | 4830 |
| 2 | 8.1 | 12.8 | 209 | 4863 | 5094 | 4842 |
| 3 | 8.9 | 13.7 | 209 | 4875 | 5122 | 4850 |
| 4 | 13.5 | 15.9 | 213 | 4869 | 5103 | 4845 |
| 5 | 9.9 | 13.0 | 212 | 4850 | 5091 | 4831 |
| 6 | 8.7 | 14.8 | 211 | 4863 | 5093 | 4828 |
| 7 | 8.8 | 12.8 | 209 | 4845 | 5070 | 4823 |
| 8 | 8.6 | 12.5 | 210 | 4894 | 5158 | 4870 |
| 9 | 8.5 | 12.8 | 209 | 4854 | 5080 | 4832 |
| 10 | 8.0 | 15.6 | 210 | 4853 | 5081 | 4829 |

Máximos observados: confirmação local 17.5 ms (meta ≤100 ms); atividade após aceite 15.9 ms (meta ≤250 ms).

A observação anterior de 4,81 s é uma referência de espera total, não uma medida de custo da interface. Este ensaio usa um provedor controlado: não demonstra redução de latência de um modelo real. O registro também separa chamada ao provedor e primeiro evento para não atribuir à interface o tempo de preparação, protocolo e resposta.

O registro `touri.response-timings.v1` permanece no armazenamento local deste navegador, limitado à primeira mensagem de dez conversas. Não guarda prompts, respostas, raciocínio ou credenciais e não faz requisições de rede. Este diretório publica somente durações e números de conversa.

O cenário separado de 35 s usa relógio controlado: confirma os avisos de 10/30 s, uma única solicitação enviada, raciocínio recolhido, chegada do texto e limpeza ao concluir. Os testes de componente cobrem autorização prioritária, ferramenta ativa, preparação do ambiente, cancelamento, falha de conexão e remoção de temporizadores.

“Verificar conexão” consulta a saúde do touri. A mensagem de sucesso esclarece que a IA ainda pode demorar; a ação não testa uma resposta paga nem reenvia a tarefa.

| Superfície | Antes | Depois | Espera longa |
| --- | --- | --- | --- |
| Desktop | [Captura](before-1440.png) | [Captura](after-1440.png) | [Captura](long-wait-1440.png) |
| Tela estreita | [Captura](before-390.png) | [Captura](after-390.png) | [Captura](long-wait-390.png) |

Regressão confirmada: os quatro testes de feedback falham na base e passam com a implementação. Os 43 testes relacionados de interface passam após integrar a base `caf4d9a`, incluindo confirmação fora de ordem, coleta anterior ao aceite HTTP e retomada após uma autorização longa. Passam também 22 testes de runtime, persistência, migração e progresso de comandos, duas verificações nativas de versão e protocolo, quatro cenários novos de navegador e 14 cenários existentes de atividade, autorização e movimento.

Formatação, tipos e build passam. A execução ampla de interface anterior à última integração teve 1.025 testes aprovados e 15 falhas; a repetição desses 15 casos após a integração passou em 13. Uma falha restante de foco também ocorre na base; a outra, de carregamento de texto formatado, passou isoladamente. A comparação das falhas do runtime com a base, repetindo os arquivos afetados por falta de espaço temporário, não encontrou falha nova reproduzível. A suíte ampla não está totalmente verde neste ambiente.
