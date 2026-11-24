import * as net from "net";

/**
 * 跨平台纯 Node.js SSH ProxyCommand 转发桥（支持 HTTP CONNECT 与 SOCKS5）
 * 用法：node proxyBridge.js <http|socks5> <proxyHost> <proxyPort> <targetHost> <targetPort>
 * 让纯 Windows 或未安装 nc 的环境也能无缝通过本地代理建立 SSH 连接。
 */
const [, , modeRaw, proxyHost, proxyPortRaw, targetHost, targetPortRaw] =
  process.argv;

const mode = (modeRaw || "").toLowerCase();
const proxyPort = Number(proxyPortRaw);
const targetPort = Number(targetPortRaw);

if (
  !mode ||
  !proxyHost ||
  !Number.isInteger(proxyPort) ||
  !targetHost ||
  !Number.isInteger(targetPort)
) {
  process.stderr.write(
    "Usage: node proxyBridge.js <http|socks5> <proxyHost> <proxyPort> <targetHost> <targetPort>\n"
  );
  process.exit(2);
}

const socket = net.createConnection({ host: proxyHost, port: proxyPort });
socket.setNoDelay(true);

const fail = (msg: string) => {
  process.stderr.write(`[proxyBridge] ${msg}\n`);
  socket.destroy();
  process.exit(1);
};

socket.on("error", (err) => fail(err.message));

function pipeBidirectional(leftover?: Buffer): void {
  if (leftover && leftover.length > 0) {
    process.stdout.write(leftover);
  }
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  process.stdin.on("end", () => socket.end());
  socket.on("end", () => process.exit(0));
}

if (mode === "http" || mode === "connect") {
  let headerBuf = Buffer.alloc(0);

  socket.once("connect", () => {
    const req =
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      `Proxy-Connection: Keep-Alive\r\n\r\n`;
    socket.write(req);
  });

  const onData = (chunk: Buffer) => {
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const sepIdx = headerBuf.indexOf("\r\n\r\n");
    if (sepIdx === -1) {
      if (headerBuf.length > 16384) {
        fail("HTTP proxy response header too large");
      }
      return;
    }
    socket.off("data", onData);
    const headerStr = headerBuf.subarray(0, sepIdx).toString("latin1");
    const statusLine = headerStr.split("\r\n")[0] || "";
    if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
      fail(`HTTP proxy CONNECT rejected: ${statusLine}`);
      return;
    }
    const leftover = headerBuf.subarray(sepIdx + 4);
    pipeBidirectional(leftover);
  };

  socket.on("data", onData);
} else if (mode === "socks5" || mode === "5") {
  let step: "greeting" | "request" = "greeting";
  let buf = Buffer.alloc(0);

  socket.once("connect", () => {
    // SOCKS5 greeting: version 5, 1 method, no-auth (0x00)
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });

  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (step === "greeting") {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05 || buf[1] !== 0x00) {
        fail(`SOCKS5 auth method rejected (0x${buf[1].toString(16)})`);
        return;
      }
      buf = buf.subarray(2);
      step = "request";

      const hostBuf = Buffer.from(targetHost, "utf8");
      if (hostBuf.length > 255) {
        fail("Target host too long for SOCKS5");
        return;
      }
      const req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 0x05; // VER
      req[1] = 0x01; // CMD = CONNECT
      req[2] = 0x00; // RSV
      req[3] = 0x03; // ATYP = DOMAINNAME
      req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      socket.write(req);
      return;
    }

    // 解析 SOCKS5 CONNECT 响应
    if (buf.length < 4) return;
    if (buf[0] !== 0x05 || buf[1] !== 0x00) {
      fail(`SOCKS5 CONNECT failed (rep=0x${buf[1].toString(16)})`);
      return;
    }
    const atyp = buf[3];
    let expectedLen = 0;
    if (atyp === 0x01) {
      expectedLen = 4 + 4 + 2;
    } else if (atyp === 0x04) {
      expectedLen = 4 + 16 + 2;
    } else if (atyp === 0x03) {
      if (buf.length < 5) return;
      expectedLen = 4 + 1 + buf[4] + 2;
    } else {
      fail(`Unsupported SOCKS5 ATYP: ${atyp}`);
      return;
    }
    if (buf.length < expectedLen) return;

    socket.off("data", onData);
    const leftover = buf.subarray(expectedLen);
    pipeBidirectional(leftover);
  };

  socket.on("data", onData);
} else {
  fail(`Unsupported proxy mode: ${mode}`);
}
