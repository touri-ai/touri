import { expect, test } from "bun:test"
import { join } from "node:path"
import {
  defaultEgressPolicy,
  type EgressPolicy,
  INSTALL_POLICY_SCRIPT,
  installEgressPolicy,
  providerHosts,
  tightenEgressPolicy,
  validateEgressPolicy,
} from "../../src/vm/egress-policy"
import { fakeVmProvider } from "./fake-provider"

test("B11 S04 live policy forms an intersection; allowing LAN and new resolvers waits for restart", () => {
  const policies: EgressPolicy[] = [
    defaultEgressPolicy(),
    { ...defaultEgressPolicy(), allowLan: true, resolvers: ["1.1.1.1"], privateDomains: ["office.example"] },
    { ...defaultEgressPolicy(), allowLan: false, resolvers: ["8.8.8.8"], privateDomains: [] },
  ]
  for (const active of policies)
    for (const requested of policies) {
      const result = tightenEgressPolicy(active, requested)
      expect(result.allowLan && !active.allowLan).toBe(false)
      expect(result.resolvers.every((ip) => active.resolvers.includes(ip) && requested.resolvers.includes(ip))).toBe(
        true,
      )
      expect(active.privateDomains.every((domain) => result.privateDomains.includes(domain))).toBe(true)
      expect(tightenEgressPolicy(result, requested)).toEqual(result)
    }
  expect(tightenEgressPolicy(defaultEgressPolicy(), policies[1] ?? defaultEgressPolicy())).toMatchObject({
    allowLan: false,
    resolvers: ["1.1.1.1"],
  })
  expect(() => validateEgressPolicy({ allowLan: true, resolvers: ["1.1.1.1;accept"], privateDomains: [] })).toThrow()
})

test("#4 public allow-list is off by default and policies saved before it still validate", () => {
  expect(defaultEgressPolicy()).toMatchObject({ restrictPublic: false, publicHosts: [] })
  expect(validateEgressPolicy({ allowLan: false, resolvers: ["1.1.1.1"], privateDomains: [] })).toEqual({
    allowLan: false,
    resolvers: ["1.1.1.1"],
    privateDomains: [],
    restrictPublic: false,
    publicHosts: [],
  })
  expect(
    validateEgressPolicy({ ...defaultEgressPolicy(), restrictPublic: true, publicHosts: ["GitHub.com", "203.0.113.7"] })
      .publicHosts,
  ).toEqual(["github.com", "203.0.113.7"])
  for (const host of ["*.github.com", "github.com; accept", "localhost", "-bad.com", "a".repeat(254), 7])
    expect(() =>
      validateEgressPolicy({ ...defaultEgressPolicy(), restrictPublic: true, publicHosts: [host] }),
    ).toThrow()
  expect(() =>
    validateEgressPolicy({ ...defaultEgressPolicy(), publicHosts: Array.from({ length: 65 }, (_, i) => `h${i}.com`) }),
  ).toThrow()
})

test("#4 enabling the allow-list applies now; removing it or adding hosts waits for restart", () => {
  const open = defaultEgressPolicy()
  const listed = { ...open, restrictPublic: true, publicHosts: ["github.com", "npmjs.org"] }
  expect(tightenEgressPolicy(open, listed)).toMatchObject({ restrictPublic: true, publicHosts: listed.publicHosts })
  expect(tightenEgressPolicy(listed, open)).toMatchObject({ restrictPublic: true, publicHosts: listed.publicHosts })
  expect(tightenEgressPolicy(listed, { ...listed, publicHosts: ["github.com", "pypi.org"] }).publicHosts).toEqual([
    "github.com",
  ])
})

test("#4 provider CLIs keep their endpoints under the allow-list", () => {
  expect(providerHosts({ provider: "codex" })).toEqual(["openai.com", "chatgpt.com"])
  expect(providerHosts({ provider: "claude" })).toContain("anthropic.com")
  expect(providerHosts({ provider: "opencode", model: "openrouter/deepseek/deepseek-v3.2" })).toContain("openrouter.ai")
})

test("#4 the allow-list runs the bundled policy script; the default keeps the image script", async () => {
  const calls: Array<{ args: string[]; user?: string }> = []
  const { provider } = fakeVmProvider()
  provider.exec = async (input) => {
    calls.push({ args: input.args ?? [], ...(input.user ? { user: input.user } : {}) })
    return { success: true, code: 0, stdout: "", stderr: "" }
  }
  await installEgressPolicy(provider, "vm", defaultEgressPolicy(), undefined, ["openai.com"])
  await installEgressPolicy(
    provider,
    "vm",
    { ...defaultEgressPolicy(), restrictPublic: true, publicHosts: ["github.com"] },
    undefined,
    ["openai.com", "github.com"],
  )
  expect(calls[0]?.args.slice(0, 2)).toEqual(["/usr/local/lib/touri/network-policy.py", "apply"])
  expect(calls[1]?.user).toBe("0")
  expect(calls[1]?.args[1]).toBe(INSTALL_POLICY_SCRIPT)
  expect(calls[1]?.args[2]).toContain("def open_answers")
  expect(JSON.parse(calls[1]?.args[3] ?? "{}")).toMatchObject({
    restrictPublic: true,
    publicHosts: ["github.com", "openai.com"],
  })
})

test("B11 private, local, compressed and reverse DNS names never reach public resolvers", async () => {
  const code = `import runpy,struct\nm=runpy.run_path(${JSON.stringify(join(import.meta.dir, "../../src/vm/image/network-policy.py"))})\ndef packet(name):\n return b'\\x00\\x01\\x01\\x00\\x00\\x01'+b'\\x00'*6+b''.join(bytes([len(p)])+p.encode() for p in name.split('.'))+b'\\x00\\x00\\x01\\x00\\x01'\np={'privateDomains':['office.example']}\nfor name in ['localhost','printer.local','intranet','db.internal','auth.office.example','1.64.168.192.in-addr.arpa','metadata.google.internal']:\n assert not m['permitted_question'](packet(name),p),name\nassert not m['permitted_question'](b'\\x00'*12+b'\\xc0\\x00\\x00\\x01\\x00\\x01',p)\nassert m['permitted_question'](packet('api.openai.com'),p)\nr={'privateDomains':[],'restrictPublic':True,'publicHosts':['openai.com','203.0.113.7']}\nassert m['permitted_question'](packet('api.openai.com'),r)\nassert m['permitted_question'](packet('openai.com'),r)\nfor name in ['exfil.example.com','notopenai.com','openai.com.evil.net','203.0.113.7']:\n assert not m['permitted_question'](packet(name),r),name\n`
  const child = Bun.spawn(["python3", "-c", code], { stdout: "pipe", stderr: "pipe" })
  expect(await child.exited).toBe(0)
})

const POLICY_SCRIPT = join(import.meta.dir, "../../src/vm/image/network-policy.py")
const runPython = async (code: string) => {
  const child = Bun.spawn(["python3", "-c", code, POLICY_SCRIPT], { stdout: "pipe", stderr: "pipe" })
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { exit, stderr }
}

test("#4 restricted packet policy drops every public address except resolved allowed ones", async () => {
  const code = `import json,sys,types
path=sys.argv[1]
g={'__name__':'policy','__file__':path}
exec(compile(open(path).read(),path,'exec'),g)
scripts=[]
class Done:
    returncode=1
    stdout=b'{}'
def run(args,input=None,**kw):
    if input: scripts.append(input.decode())
    return Done()
g['subprocess']=types.SimpleNamespace(run=run,check_output=lambda a:b'[{"gateway":"192.0.2.1"}]',DEVNULL=-3,SubprocessError=Exception,Popen=None)
g['CONFIG']=path+'.test-config-missing/x'
g['ensure_forwarder']=lambda:None
g['open']=lambda *a,**k:(_ for _ in ()).throw(OSError('no writes in tests'))
for allow_lan in (False,True):
    scripts.clear()
    try: g['apply']({'allowLan':allow_lan,'resolvers':['1.1.1.1'],'privateDomains':[],'restrictPublic':True,'publicHosts':['openai.com','203.0.113.7'],'hostAddresses':[]})
    except OSError: pass
    s=scripts[-1]
    assert 'set allow4' in s and 'ip daddr @allow4 accept' in s and 'ip6 daddr @allow6 accept' in s,s
    assert '\\naccept\\n' not in s,s
    assert 'add element inet touri allow4 { 203.0.113.7 }' in s,s
    assert ('192.168.0.0/16 } accept' in s)==allow_lan,s
    assert s.index('ip daddr 192.0.2.1 drop')<s.index('@allow4'),s
scripts.clear()
try: g['apply']({'allowLan':False,'resolvers':['1.1.1.1'],'privateDomains':[],'hostAddresses':[]})
except OSError: pass
assert 'allow4' not in scripts[-1] and '\\naccept\\n' in scripts[-1],scripts[-1]
`
  const result = await runPython(code)
  expect(result.stderr).toBe("")
  expect(result.exit).toBe(0)
})

test("#4 the DNS forwarder opens only the A/AAAA answers of an allowed name, with compression and CNAMEs", async () => {
  const code = `import runpy,struct,sys
m=runpy.run_path(sys.argv[1])
def name(n): return b''.join(bytes([len(p)])+p.encode() for p in n.split('.'))+b'\\x00'
q=b'\\x12\\x34\\x81\\x80\\x00\\x01\\x00\\x03\\x00\\x00\\x00\\x00'+name('api.openai.com')+b'\\x00\\x01\\x00\\x01'
cname=b'\\xc0\\x0c\\x00\\x05\\x00\\x01\\x00\\x00\\x00\\x3c'+struct.pack('!H',len(name('edge.cdn.example')))+name('edge.cdn.example')
a=b'\\xc0\\x2c\\x00\\x01\\x00\\x01\\x00\\x00\\x00\\x0a\\x00\\x04'+bytes([203,0,113,9])
aaaa=b'\\xc0\\x2c\\x00\\x1c\\x00\\x01\\x00\\x00\\x0e\\x10\\x00\\x10'+bytes(15)+b'\\x01'
found=m['answer_addresses'](q+cname+a+aaaa)
assert found==[('allow4','203.0.113.9',10),('allow6','::1',3600)],found
assert m['answer_addresses'](q+cname[:5])==[]
assert m['answer_addresses'](b'\\x00')==[]
`
  const result = await runPython(code)
  expect(result.stderr).toBe("")
  expect(result.exit).toBe(0)
})
