#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { Command } = require('commander')
const DHT = require('hyperdht')
const goodbye = require('graceful-goodbye')
const Protomux = require('protomux')
const readFile = require('read-file-live')
const HypercoreId = require('hypercore-id-encoding')
const { SHELLDIR } = require('../constants.js')
const { waitForSocketTermination } = require('../lib/client-socket.js')
const { ShellServer } = require('../lib/shell.js')
const { UploadServer } = require('../lib/upload.js')
const { DownloadServer } = require('../lib/download.js')
const { LocalTunnelServer } = require('../lib/local-tunnel.js')
const configs = require('tiny-configs')
const keygen = require('./keygen.js')

const PROTOCOLS = ['shell', 'upload', 'download', 'tunnel']

const program = new Command()

program
  .description('Create a P2P shell server.')
  .option('-f <filename>', 'Filename of the server seed key.', path.join(SHELLDIR, 'peer'))
  // .option('--key <hex or z32>', 'Inline key for the server.')
  .option('--firewall <filename>', 'List of allowed public keys.', path.join(SHELLDIR, 'authorized_peers'))
  .option('--disable-firewall', 'Allow anyone to connect.', false)
  .option('--protocol <name...>', 'List of allowed protocols.')
  .option('--tunnel-host <address...>', 'Restrict tunneling to a limited set of hosts.')
  .option('--tunnel-port <port...>', 'Restrict tunneling to a limited set of ports.')
  .option('--testnet', 'Use a local testnet.', false)
  .action(cmd)
  .parseAsync()

async function cmd (options = {}) {
  const keyfile = path.resolve(options.f)
  const firewall = path.resolve(options.firewall)
  const protocols = options.protocol || PROTOCOLS

  if (!fs.existsSync(keyfile)) {
    await keygen({ f: keyfile })
  }

  let allowed = options.disableFirewall === true
  if (!allowed) {
    allowed = readAuthorizedPeers(firewall)
    const unwatchFirewall = readFile(firewall, function (buf) {
      allowed = readAuthorizedPeers(buf)
    })
    goodbye(() => unwatchFirewall(), 3)
  }
  const seed = HypercoreId.decode(fs.readFileSync(keyfile, 'utf8').trim())
  const keyPair = DHT.keyPair(seed)

  const node = new DHT({ bootstrap: options.testnet ? [{ host: '127.0.0.1', port: 40838 }] : undefined })
  goodbye(() => node.destroy(), 3)

  const server = node.createServer({ firewall: onFirewall })
  goodbye(() => server.close(), 2)

  server.on('connection', onconnection.bind(server, { protocols, options }))

  await server.listen(keyPair)

  if (protocols === PROTOCOLS) {
    console.log('To connect to this shell, on another computer run:')
    console.log('hypershell ' + HypercoreId.encode(keyPair.publicKey))
  } else {
    console.log('Running server with restricted protocols')
    console.log('Server key: ' + HypercoreId.encode(keyPair.publicKey))
  }
  console.log()

  function onFirewall (remotePublicKey, remoteHandshakePayload) {
    if (allowed === true) {
      console.log('Firewall allowed:', HypercoreId.encode(remotePublicKey))
      return false
    }

    for (const publicKey of allowed) {
      if (remotePublicKey.equals(publicKey)) {
        console.log('Firewall allowed:', HypercoreId.encode(remotePublicKey))
        return false
      }
    }

    console.log('Firewall denied:', HypercoreId.encode(remotePublicKey))
    return true
  }
}

function onconnection ({ protocols, options }, socket) {
  const node = this.dht

  socket.on('end', () => socket.end())
  socket.on('close', () => console.log('Connection closed', HypercoreId.encode(socket.remotePublicKey)))
  socket.on('error', function (error) {
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return
    console.error(error.code, error)
  })

  socket.setKeepAlive(5000)

  const unregisterSocket = goodbye(() => {
    socket.end()
    return waitForSocketTermination(socket)
  }, 1)
  socket.once('close', () => unregisterSocket())

  const mux = new Protomux(socket)

  if (protocols.includes('shell')) {
    mux.pair({ protocol: 'hypershell' }, function () {
      const shell = new ShellServer({ node, socket, mux })
      if (!shell.channel) return
      shell.open()
    })
  }

  if (protocols.includes('upload')) {
    mux.pair({ protocol: 'hypershell-upload' }, function () {
      const upload = new UploadServer({ node, socket, mux })
      if (!upload.channel) return
      upload.open()
    })
  }

  if (protocols.includes('download')) {
    mux.pair({ protocol: 'hypershell-download' }, function () {
      const download = new DownloadServer({ node, socket, mux })
      if (!download.channel) return
      download.open()
    })
  }

  if (protocols.includes('tunnel')) {
    mux.pair({ protocol: 'hypershell-tunnel-local' }, function () {
      const tunnel = new LocalTunnelServer({ node, socket, mux, options })
      if (!tunnel.channel) return
      tunnel.open()
    })
  }
}

function readAuthorizedPeers (filename) {
  if (typeof filename === 'string' && !fs.existsSync(filename)) {
    console.log('Notice: creating default firewall', filename)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, '# <public key> <name>\n', { flag: 'wx' })
  }

  try {
    const list = typeof filename === 'string' ? fs.readFileSync(filename, 'utf8') : filename
    return configs.parse(list,{ split: ' ', length: 2 })
      .map(v => HypercoreId.decode(v[0]))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
