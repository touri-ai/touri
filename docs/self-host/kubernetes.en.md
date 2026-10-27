# touri on Kubernetes

[Português](kubernetes.md)

Use this deployment for **one person or a small trusted team**: a StatefulSet with **one replica**
and one PVC. touri listens on `127.0.0.1:8795`; the nginx sidecar in the same pod accepts HTTPS
on 8443. Never expose 8795 through a Service, hostPort or hostNetwork. Pairing is mandatory,
including when the retired `--no-pair` option is present.

## Installation

Use Linux amd64 nodes, a runtime supporting user namespaces and idmapped volumes, Kubernetes
supporting `hostUsers: false` and native sidecars, a default StorageClass and an Ingress controller
configured for HTTPS to its backend. See the [user namespace requirements](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/).
Adapt the Ingress class and its backend annotation for your controller. Use a certificate covering
`touri.example.com`.

```sh
docker build --platform linux/amd64 -t touri-self-host:local .
# Publish to your registry and replace both application image references in the manifest.
kubectl create namespace touri
kubectl -n touri create secret tls touri-tls --cert=tls.crt --key=tls.key
kubectl -n touri create configmap touri-nginx --from-file=nginx.conf=docs/self-host/nginx.conf
kubectl -n touri apply -f docs/self-host/kubernetes.yaml
kubectl -n touri rollout status statefulset/touri
kubectl -n touri exec touri-0 -c touri -- touri doctor --data-dir /data
kubectl -n touri exec -it touri-0 -c touri -- touri pair --data-dir /data
```

Open `https://touri.example.com` and enter the pairing code on your device. Without Ingress,
forward pod port 8443 and use HTTPS with a test certificate. Keep pairing codes, cookies, tokens
and `/data` contents out of test evidence.

## Browser and security limits

The image contains stable Chrome, Xvfb, fonts, Node 22 and the provider CLIs. touri starts Xvfb.
There is no container runtime inside the pod; isolated bot computers remain disabled in server mode.
Bots are **ordinary processes running as the same user**, without isolation between people.
Cluster administrators or compromised processes can reach data and credentials. This is unsuitable
for hosting mutually untrusted users. Do not mount container sockets, host directories or cluster credentials.

Chrome's sandbox stays enabled by default. `hostUsers: false` maps pod users but does not guarantee
that Chrome can create its additional namespaces: the runtime, kernel and seccomp/AppArmor policy
must also allow them. Run `touri doctor` inside the pod and open a page. The doctor probes user/network
namespaces; a positive result does not prove that Chrome can start.

As a last resort, an operator may explicitly set `TOURI_BROWSER_NO_SANDBOX=1` in the application
container. **This removes Chrome's sandbox: malicious pages may access process files and credentials.**
Accept that risk before enabling it. No failure enables it automatically; doctor reports a warning.
See the [sandbox documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/sandboxing.md).
If the runtime cannot create the pod's own user namespace, remove `hostUsers: false` before using
this alternative; the pod also loses that layer of isolation from the host.
The 512 MiB memory volume at `/dev/shm` avoids the usual small container limit and counts toward memory
usage. If you cannot mount it, set `TOURI_BROWSER_DISABLE_DEV_SHM_USAGE=1` and provide temporary disk
space at `/tmp`. That option does not disable the sandbox.

## Persistence and operation

Keep **`HOME=/data/home` together with `--data-dir /data`**. `serve` does not change HOME itself.
The PVC preserves databases, attachments, bots, managed browser profiles, imports, sessions and CLI
configuration/login files. Home-based defaults, including imported workspaces and session checks,
stay under that HOME. Explicit XDG, CLI or workspace paths outside the PVC will not persist. Desktop
behavior is unchanged. A non-root init container creates a private subdirectory: `fsGroup` alone
does not make the application own the volume root. Your storage driver must honor `fsGroup`.

`/healthz` measures liveness only. `/readyz` returns 503 during startup/drain and 200 after runtime
initialization. Both public endpoints omit identity, version and diagnostics and open no SQLite
connection per request. Probes use HTTPS through nginx. The 90-second termination grace includes
60 seconds for draining and 20 for cleanup; the native sidecar stays alive until the app finishes.
Never increase replicas or share a live data directory between servers.

Proxy access and error logs are disabled: upstream errors can include request URLs containing
short-lived browser connection tickets. Diagnose availability with the probes, pod events and
application logs; keep those diagnostics private too.

Allow DNS and HTTPS egress for selected providers, CLI sign-in, git repositories, MCP services and
sites bots need. Bots do not need access to the Kubernetes API. Preserve authentication when testing
connectivity and account for these destinations in any egress policy.

For a consistent backup, scale to zero (`kubectl -n touri scale statefulset touri --replicas=0`), wait
for termination and copy/snapshot the **whole PVC**, preserving permissions. It includes `secrets.key`,
encrypted secrets, logins and browser sessions: **treat backups as credentials**, encrypt them and
restrict access. Restore offline with the same version/user, return to one replica and verify history
and logins. Take a snapshot before upgrades, use versioned images, preserve the PVC on redeployment
and test restoration before relying on your backups. Never publish backups.
