# Levar seus dados para outro servidor

O touri guarda conversas, bots e arquivos na pasta de dados escolhida para a instalação.
O app continua usando essa pasta ao concluir a configuração. Conectar outro servidor muda
onde o app trabalha; isso não copia nem apaga os dados locais.

As pastas padrão do app são `~/Library/Application Support/touri` no Mac,
`~/.local/share/touri` no Linux e `%APPDATA%/touri` no Windows. O comando
`touri serve` usa `~/.touri` por padrão. Se você escolheu outra pasta com
`TOURI_APP_DATA` ou `--data-dir`, use essa pasta. Não junte pastas de instalações diferentes.

Para mudar de computador preservando o histórico:

1. Atualize as duas instalações para a mesma versão do touri.
2. Pare os bots e feche completamente o touri na origem e no destino. Não copie um banco em uso.
3. Faça uma cópia de segurança da **pasta de dados inteira** da origem, incluindo os arquivos
   auxiliares do banco. Mantenha essa cópia até conferir o resultado.
4. Transfira a pasta por um meio privado para uma pasta vazia no destino, preservando as
   permissões. Não publique a pasta nem a envie em um pedido de suporte.
5. No destino, inicie `touri serve --data-dir <pasta-copiada>`. Se usar acesso privado pelo
   celular, acrescente `--tailscale`, depois de entrar na sua rede privada naquele computador.
6. Gere um código novo com `touri pair --data-dir <pasta-copiada>`. No app, abra
   **Configurações → Usar um servidor touri → Configurar onde o touri roda → Conectar ao meu servidor**.
7. Confira bots, conversas e arquivos antes de retomar o trabalho. Reautorize as contas de IA,
   navegadores e pastas que pertenciam ao computador anterior. Credenciais do cofre do sistema
   não são transferidas pela cópia. Nunca exporte chaves como texto para resolver isso.

O armazenamento de segredos de uma instalação de servidor pode incluir uma chave local:
proteja a pasta inteira como uma credencial. Códigos de pareamento expiram; gere novos códigos
para os aparelhos que precisar reconectar. Dois servidores não devem usar a mesma pasta ao
mesmo tempo. A origem continua sendo sua cópia de retorno caso precise desfazer a mudança.

A mudança ainda é manual. Não há sincronização automática entre instalações.

# Move your data to another server

The desktop defaults are `~/Library/Application Support/touri` on Mac,
`~/.local/share/touri` on Linux and `%APPDATA%/touri` on Windows. The command
`touri serve` defaults to `~/.touri`. Honor any custom `TOURI_APP_DATA`,
`XDG_DATA_HOME` or `--data-dir` setting. Do not combine directories from different installations.

Connecting to a different server changes where the app works; it does not transfer or erase
local data. Update both installations to the same version. Stop bots and fully quit touri on
both computers before copying anything. Back up the entire data directory, including database
auxiliary files, and keep that backup until you have verified the result.

Transfer the directory privately into an empty destination, preserving its permissions.
Start `touri serve --data-dir <copied-directory>`, adding `--tailscale` for private phone access
after signing in on the destination. Generate a new code with
`touri pair --data-dir <copied-directory>`. In the app, open **Settings → Use a touri server →
Choose where touri runs → Connect to my server**.

Check bots, history and files before resuming work. Authorize AI accounts, browsers and local
folders again. System vault credentials do not move with the directory; do not export keys as
plain text. A server directory may contain its encrypted secret store and local encryption key,
so protect the entire copy as a credential. Never publish it or attach it to support requests.

Keep the source as a rollback copy. Never run two servers against one directory. Moving is
currently manual; installations do not synchronize automatically.
