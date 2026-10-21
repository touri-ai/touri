import { expect, test } from "bun:test"
import { getAddressReachability, parsePublicAddress } from "../../src/cli/public-address"

test("public address settings normalize origins and reject path, credential, and non-web URLs", () => {
  expect(parsePublicAddress("  https://team.example.test:8443/  ")).toBe("https://team.example.test:8443")
  expect(parsePublicAddress("http://localhost:8795")).toBeNull()
  expect(parsePublicAddress("https://team.example.test/app")).toBeNull()
  expect(parsePublicAddress("https://user:pass@team.example.test")).toBeNull()
  expect(parsePublicAddress("file:///tmp/touri")).toBeNull()
})

test("reachability hints distinguish public, local, private, and tailnet-only origins", () => {
  expect(getAddressReachability("https://team.example.test")).toBe("public")
  expect(getAddressReachability("http://localhost:8795")).toBe("localhost")
  expect(getAddressReachability("http://192.168.1.20:8795")).toBe("private")
  expect(getAddressReachability("http://100.64.0.5:8795")).toBe("private")
  expect(getAddressReachability("https://[2a00::1]")).toBe("public")
  expect(getAddressReachability("https://[2001:db8::1]")).toBe("private")
  expect(getAddressReachability("https://laptop.example.ts.net")).toBe("tailnet")
  expect(getAddressReachability("not a URL")).toBe("invalid")
})
