# Lista de bots durante a preparação

A referência anterior é `origin/main` em `2ec1a47`. A interface completa roda no servidor de desenvolvimento com uma API de teste: `/bots` responde normalmente; todas as outras consultas ficam pendentes em uma barreira controlada.

| Antes | Depois |
| --- | --- |
| [Tela de preparação mesmo com os bots disponíveis](before-pending.png) | [Lista de bots enquanto os detalhes ainda carregam](after-pending.png) |

O carregamento aguardava onze consultas em conjunto e depois as listas de conversas de todos os bots e grupos. Entre as consultas secundárias, a listagem de abas pode aguardar a comunicação com máquinas em execução. A lista agora é publicada ao receber `/bots`, inclusive quando está vazia. A resolução de links e do histórico continua aguardando o índice completo.

O teste de integração comprova que a lista aparece antes de liberar qualquer consulta secundária e que uma seleção feita nesse intervalo permanece após o carregamento completo. A reprodução falha na referência anterior. O build da interface também foi validado pelo gate.

VISION: promessa 7 (interface rápida e clara).
