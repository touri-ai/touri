# Importar agentes

O dono pode copiar agentes do servidor onde o touri está rodando. A importação não altera a origem e não usa serviços externos. O contrato de `packages/contracts/src/agent-import.ts` é compartilhado com o onboarding.

| Rota | Operação |
| --- | --- |
| `GET /api/v1/import/sources` | Detecta a pasta do Claude Code no servidor e oferece pasta ou JSON manual. |
| `POST /api/v1/import/preview` | Recebe `{source, path?, payload?}` e retorna contagens, itens excluídos e uma prévia válida por dez minutos. |
| `POST /api/v1/import/apply` | Recebe `{previewId, select}`; cada chave de agente seleciona instruções, skills, memórias e rotinas. |
| `POST /api/v1/import/undo` | Recebe `{importId}` e inicia a remoção dos bots e recursos criados por essa importação. |

A prévia existe apenas em memória: não cria arquivos, bots, rotinas nem registros no banco. O servidor mantém as três prévias mais recentes; uma nova prévia substitui a mais antiga. Um reinício exige outra prévia. A aplicação usa o conteúdo revisado, mesmo se a origem mudar depois. Repetir a mesma aplicação enquanto a prévia estiver disponível devolve o mesmo resultado; outra seleção exige nova prévia.

## Fontes

**Claude Code:** lê `CLAUDE.md`, `projects/*/CLAUDE.md`, `projects/*/memory/*.md`, `skills/*/SKILL.md` e seus arquivos de apoio. Cada projeto com instruções ou memória vira um agente; sem projetos, há um agente. Instruções globais e skills são compartilhadas por cópia. O arquivo global `~/.claude.json` e os arquivos `settings.json`, `claude.json` e `settings/*.json` da pasta detectada fornecem somente nomes de servidores MCP. Valores de configuração permanecem no worker de arquivos e não entram na prévia, no banco ou nos eventos.

**Pasta:** escolha uma pasta de exportação no servidor. Markdown fora de `skills/`, `memory/`, `memories/` e `notes/` fornece instruções. Memórias vêm dessas pastas ou de `MEMORY.md`. Skills ficam em `skills/<nome>/SKILL.md`, com arquivos de apoio. `jobs.json`, `routines.json` e `cron.json` aceitam uma lista de `{name, schedule, prompt}` ou `{jobs: [...]}`. `crontab` e `routines.cron` aceitam cinco campos de agenda seguidos pelo texto da tarefa. Esse texto vira um prompt de rotina pausada; nenhum comando da origem é executado durante a importação.

**Manual:** `payload` aceita um objeto ou texto JSON com o seguinte formato. Campos desconhecidos, tipos incorretos, nomes inválidos e agendas incompatíveis são recusados. Todos os campos do exemplo são obrigatórios.

```json
{
  "agents": [{
    "name": "Notas",
    "personality": "Organiza notas",
    "instructions": "Prefira respostas curtas.",
    "skills": [{"name": "resumir", "content": "Resuma as notas."}],
    "memories": ["O projeto usa português."],
    "routines": [{"name": "Revisar notas", "schedule": "0 9 * * *", "prompt": "Revise as notas."}],
    "integrations": ["Calendário"]
  }]
}
```

## Controle e limites

Somente o dono autenticado pode usar as quatro rotas. Outros administradores, membros, automações e sessões revogadas são recusados. O acesso local do aplicativo preserva a autenticação do servidor. As permissões de um agente importado não vêm da origem: ele começa com arquivos somente para leitura, aprovações explícitas e sem navegador ou controle do computador. O dono pode configurar essas capacidades depois.

Bots ficam pausados enquanto os arquivos são copiados. Ao concluir, ficam disponíveis para conversa. Rotinas ficam pausadas até o dono ativar cada uma. Integrações são nomes para reconectar; nenhuma configuração executável ou credencial é instalada. As agendas usam UTC e precisam respeitar o intervalo mínimo de cinco minutos das rotinas do touri.

A leitura aceita até 64 KiB por arquivo, 1 MiB por pasta ou JSON, 2.000 entradas, seis níveis e vinte agentes. Prompts de rotina aceitam até 8.000 bytes. Cada agente aceita até cem skills, memórias e rotinas; o corpo HTTP aceita até 256 KiB. A busca termina em dez segundos. Diretórios muito grandes ou entradas acima do orçamento exigem uma exportação menor. Arquivos individuais grandes, binários, links e conteúdo suspeito são excluídos. O navegador não precisa receber o conteúdo completo para revisar a importação.

Nomes de arquivos de ambiente, credenciais, tokens, autenticação, chaves e keychains são excluídos antes da leitura. Arquivos de texto contendo padrões reconhecidos de segredos são descartados antes de formar a prévia. `excluded.secrets` conta os arquivos, campos ou diretórios secretos excluídos; `excluded.files` conta outras exclusões. Valores desconhecidos sem formato reconhecível não podem ser identificados automaticamente: revise a pasta de exportação antes de escolhê-la.

A pasta escolhida precisa ser um diretório regular, nunca um link simbólico. Aliases nos diretórios pais são resolvidos antes de verificar o escopo; o caminho original e o canônico recusam nomes secretos, e dados privados do aplicativo continuam proibidos. Aberturas de arquivos fixam os ancestrais canônicos e recusam links simbólicos, múltiplos links e escapes de caminho. Escritas ficam na nova pasta privada do bot, com modo `0600`, usando o worker de arquivos existente. A origem nunca é destino de escrita. Conteúdo suspeito de tentar sobrescrever instruções de segurança é excluído; conteúdo importado não concede permissões nem aprova ações.

Memórias de até 3.000 caracteres usam `MEMORY.md` no formato do aprendizado existente. Memórias maiores também são preservadas integralmente em `memory/imported-N.md`, com referências e um trecho limitado em `MEMORY.md`.

## Progresso e desfazer

As chaves dos agentes são opacas e exclusivas de cada prévia; use os valores retornados ao selecionar e acompanhar o progresso de várias fontes.

O stream existente publica eventos `agent.import.progress` com os campos de `AgentImportProgress`: `importId`, `agentKey`, `step`, `done` e `total`. Os passos são `instructions`, `skills`, `memories`, `routines`, `done` e `failed`. As contagens são passos concluídos por agente, de zero a quatro; não representam bytes. Eventos não contêm arquivos, caminhos de origem nem segredos.

Um registro durável guarda apenas os IDs de bots e rotinas criados. Desfazer continua disponível depois de reiniciar, usa a exclusão progressiva existente e preserva bots anteriores. `removedBots` conta as exclusões iniciadas; a limpeza física continua em segundo plano. Repetir o desfazer retorna zero. Falhas durante a aplicação iniciam a limpeza dos recursos já criados. Não há sobrescrita de bots existentes.

# Import agents

The owner can import from the server host using a detected Claude Code folder, a selected export folder, or strictly validated JSON. Preview writes nothing and expires after ten minutes. Apply copies the reviewed content; routines remain paused and integrations are names to reconnect. Undo removes only resources created by that import and survives server restarts.

Imported bots use read-only file access, explicit approvals, and no browser or computer control. Secret filenames are skipped before reading; recognized secret values and suspicious instructions are discarded before caching. Files are limited to 64 KiB, sources to 1 MiB, scans to 2,000 entries/six levels/ten seconds, and imports to twenty agents. HTTP bodies are capped at 256 KiB. Files use descriptor-relative reads and private writes. No source command, integration configuration, or supporting script runs during import. Schedules use UTC.

Progress uses `agent.import.progress` on the existing event stream. The UI can subscribe before applying and correlate each agent by `agentKey`. New UI screens and their interaction performance are covered by the onboarding UI change; this change supplies the server and typed client contract.
