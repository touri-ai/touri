# touri no Kubernetes

[English](kubernetes.en.md)

Este exemplo é para **uma pessoa ou uma equipe pequena de confiança**, com um StatefulSet de
**uma réplica** e um PVC. O touri escuta somente em `127.0.0.1:8795`; o nginx no mesmo pod
recebe HTTPS em 8443. Não exponha a porta 8795 por Service, hostPort ou hostNetwork.
O pareamento continua obrigatório, inclusive com `--no-pair`, que é uma opção antiga.

## Preparar e instalar

Use nós Linux amd64, um runtime com namespaces de usuário e suporte a volumes com idmap,
Kubernetes com suporte a `hostUsers: false` e sidecars nativos, um StorageClass padrão e um
controlador de Ingress configurado para HTTPS no backend. Consulte os requisitos de
[namespaces de usuário](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/).
O manifesto usa a configuração de backend do controlador indicado em `ingressClassName`;
adapte essa configuração ao seu controlador. O certificado deve cobrir `touri.example.com`.

```sh
docker build --platform linux/amd64 -t touri-self-host:local .
# Publique em seu registro e substitua as duas referências à imagem no manifesto.
kubectl create namespace touri
kubectl -n touri create secret tls touri-tls --cert=tls.crt --key=tls.key
kubectl -n touri create configmap touri-nginx --from-file=nginx.conf=docs/self-host/nginx.conf
kubectl -n touri apply -f docs/self-host/kubernetes.yaml
kubectl -n touri rollout status statefulset/touri
kubectl -n touri exec touri-0 -c touri -- touri doctor --data-dir /data
kubectl -n touri exec -it touri-0 -c touri -- touri pair --data-dir /data
```

Abra `https://touri.example.com` e use o código de pareamento no seu aparelho. Para testar sem
Ingress, encaminhe a porta 8443 do pod e use HTTPS com um certificado de teste. Não publique
códigos, cookies, tokens nem o conteúdo de `/data` na evidência de testes.

## Navegador e limites de segurança

A imagem inclui Chrome stable, Xvfb, fontes, Node 22 e as CLIs dos provedores. O touri inicia
seu próprio Xvfb. Não há runtime de contêiner dentro do pod; os computadores isolados dos bots
continuam desativados no servidor. Os bots são **processos comuns com o mesmo usuário** no pod,
não fronteiras de isolamento entre pessoas. Administradores do cluster e processos comprometidos
podem alcançar dados e credenciais. Não use esta instalação como serviço multiusuário não confiável.
Não monte sockets de contêiner, diretórios do host nem credenciais do cluster.

O sandbox do navegador fica ativo por padrão. `hostUsers: false` mapeia os usuários do pod,
mas não garante sozinho que o runtime permita os namespaces adicionais do Chrome: políticas
seccomp/AppArmor e o kernel também precisam permitir essa operação. Rode `touri doctor` dentro
do pod e valide a abertura de uma página. O diagnóstico verifica namespaces de usuário/rede;
um resultado positivo não substitui o teste do Chrome.

Se não for possível habilitar os namespaces, o operador pode definir explicitamente
`TOURI_BROWSER_NO_SANDBOX=1` no contêiner touri. **Isso remove o sandbox do Chrome: uma página
maliciosa pode acessar arquivos e credenciais do processo.** Use apenas após aceitar esse risco;
nenhuma falha ativa essa opção automaticamente. O doctor mostra um aviso. Consulte também a
[documentação do sandbox](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/sandboxing.md).
Se o runtime não conseguir criar o próprio namespace de usuário do pod, remova `hostUsers: false`
do manifesto antes de usar essa alternativa; o pod perde também essa camada de isolamento do host.
O volume em memória de 512 MiB em `/dev/shm` evita o limite pequeno habitual dos contêineres e
conta para o limite de memória. Se não puder montá-lo, `TOURI_BROWSER_DISABLE_DEV_SHM_USAGE=1`
passa a usar arquivos temporários; reserve espaço em `/tmp`. Essa opção não desativa o sandbox.

## Persistência, prontidão e recuperação

Mantenha **`HOME=/data/home` e `--data-dir /data` juntos**. O touri não redefine HOME ao executar
`serve`. O PVC preserva banco, anexos, bots, perfis gerenciados, importações, sessões e os arquivos
de configuração/login das CLIs. Caminhos padrão baseados em `~`, incluindo workspaces importados
e as verificações de sessões, ficam abaixo desse HOME. Não configure diretórios XDG, configurações
das CLIs ou pastas de trabalho fora do PVC se precisar preservá-los. No desktop nada muda.
O init container sem privilégios cria um subdiretório privado no PVC, pois `fsGroup` sozinho não
torna o usuário dono da raiz do volume. O driver de armazenamento precisa respeitar `fsGroup`.

`/healthz` mede apenas vida do processo; `/readyz` responde 503 na inicialização e no encerramento,
e 200 depois da inicialização do runtime. Ambos são públicos, sem versão, identidade ou diagnóstico,
e não abrem SQLite por requisição. As probes passam pelo nginx com HTTPS. O tempo de encerramento
é 90 segundos: até 60 de drenagem e 20 de limpeza. O sidecar nativo mantém o proxy enquanto a
aplicação termina. Nunca aumente as réplicas nem monte o mesmo diretório em dois servidores ativos.

Permita DNS e saída HTTPS para os provedores escolhidos, autenticação das CLIs, repositórios git,
serviços MCP e sites que os bots usarão. Não é necessário abrir o Kubernetes API para os bots.
Restrições de saída devem considerar esses destinos; não desative autenticação para testar a rede.

Para backup consistente, pare o StatefulSet (`kubectl -n touri scale statefulset touri --replicas=0`),
aguarde o pod encerrar e copie ou tire um snapshot **do PVC inteiro**, preservando permissões.
O backup inclui `secrets.key`, dados criptografados, logins e sessões do navegador: **trate-o como
uma credencial**, com criptografia e acesso restrito. Restaure offline na mesma versão, monte o
PVC com o mesmo usuário, volte a uma réplica e confira histórico e logins. Não publique backups.
Faça atualização com snapshot prévio, imagem versionada e apenas uma instância; preserve o PVC
em reinstalações e exclusões do StatefulSet. Valide restauração antes de depender do backup.
