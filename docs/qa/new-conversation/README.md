# Nova conversa e primeiro envio

Reprodução na interface completa, no servidor de desenvolvimento, com a resposta de criação retida por uma barreira controlada. O texto é digitado antes de liberar essa resposta. A referência anterior é `origin/main` em `2ec1a47`.

| Momento | Antes | Depois |
| --- | --- | --- |
| Criação pendente | [Enviar habilitado, com o histórico anterior](before-pending.png) | [Conversa vazia, rascunho editável e envio bloqueado](after-pending.png) |
| Criação concluída | [Rascunho apagado](before-ready.png) | [Mesmo rascunho, pronto para enviar na nova conversa](after-ready.png) |

O teste de integração retém a criação e tenta submeter o formulário nesse intervalo. Depois verifica o ID usado no envio e o pai nulo da primeira mensagem. Executa o mesmo fluxo nos modos web, desktop local e desktop com servidor. Também cobre falha e nova tentativa, grupos, navegação durante a criação, bloqueio antes da próxima renderização e o compositor do projeto.

As capturas usam uma API de teste; nenhum processo de execução de tarefa é iniciado. O build da interface também foi validado pelo gate. Os testes de regressão falham na referência anterior.

VISION: promessas 3 (nada se perde), 4 (a pessoa controla a execução) e 7 (interface clara).
