#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const root = process.cwd()
const requiredServers = ['memory', 'context7', 'sequentialthinking']
const checks = []

function run(command) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function check(name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, ok: true, detail: detail || 'ok' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ name, ok: false, detail: message })
  }
}

function readJson(filePath) {
  const absolute = path.resolve(root, filePath)
  const raw = fs.readFileSync(absolute, 'utf8')
  return JSON.parse(raw)
}

function assertDockerRun(server, imageName) {
  if (server.type !== 'stdio') throw new Error(`expected stdio type for ${imageName}`)
  if (server.command !== 'docker') throw new Error(`expected docker command for ${imageName}`)
  const expected = ['run', '-i', '--rm', imageName]
  const actual = server.args || []
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected args ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`)
  }
}

function summarize() {
  const failures = checks.filter((c) => !c.ok)
  console.log('\nMCP Doctor Report')
  console.log('=================')
  for (const item of checks) {
    const status = item.ok ? 'PASS' : 'FAIL'
    console.log(`[${status}] ${item.name} :: ${item.detail}`)
  }
  console.log('=================')
  if (failures.length > 0) {
    console.error(`MCP doctor failed (${failures.length} checks).`)
    process.exitCode = 1
    return
  }
  console.log('MCP doctor passed.')
}

await check('vscode mcp schema', () => {
  const cfg = readJson('.vscode/mcp.json')
  if (!cfg.servers || typeof cfg.servers !== 'object') {
    throw new Error('missing servers object')
  }
  for (const key of requiredServers) {
    if (!cfg.servers[key]) throw new Error(`missing server '${key}'`)
  }
  const keys = Object.keys(cfg.servers).sort()
  if (JSON.stringify(keys) !== JSON.stringify(requiredServers.slice().sort())) {
    throw new Error(`unexpected server keys: ${keys.join(', ')}`)
  }
  return 'memory/context7/sequentialthinking present'
})

await check('vscode memory config', () => {
  const cfg = readJson('.vscode/mcp.json')
  const memory = cfg.servers.memory
  if (memory.type !== 'sse') throw new Error('memory must use sse')
  const expected = 'http://localhost:8765/mcp/claude/sse/zincdigital'
  if (memory.url !== expected) throw new Error(`memory url mismatch (${memory.url})`)
  return memory.url
})

await check('vscode context7 config', () => {
  const cfg = readJson('.vscode/mcp.json')
  assertDockerRun(cfg.servers.context7, 'mcp/context7')
  return 'docker run -i --rm mcp/context7'
})

await check('vscode sequentialthinking config', () => {
  const cfg = readJson('.vscode/mcp.json')
  assertDockerRun(cfg.servers.sequentialthinking, 'mcp/sequentialthinking')
  return 'docker run -i --rm mcp/sequentialthinking'
})

await check('project .mcp.json (optional)', () => {
  const projectPath = path.resolve(root, '.mcp.json')
  if (!fs.existsSync(projectPath)) return 'skipped (.mcp.json not present)'
  const cfg = readJson('.mcp.json')
  const servers = cfg.mcpServers || {}
  for (const key of requiredServers) {
    if (!servers[key]) throw new Error(`missing server '${key}'`)
  }
  return 'present and contains required servers'
})

await check('openmemory api health', async () => {
  const response = await fetch('http://localhost:8765/docs')
  if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`)
  return 'http://localhost:8765/docs -> 200'
})

await check('openmemory containers', () => {
  const names = run("docker ps --format '{{.Names}}'")
  if (!/openmemory-openmemory-mcp-1/m.test(names)) {
    throw new Error('openmemory-openmemory-mcp-1 not running')
  }
  if (!/openmemory-mem0_store-1/m.test(names)) {
    throw new Error('openmemory-mem0_store-1 not running')
  }
  return 'backend containers running'
})

await check('docker mcp servers', () => {
  const out = run('docker mcp server ls')
  if (!/\bcontext7\b/.test(out)) throw new Error('context7 not enabled in docker mcp')
  if (!/\bsequentialthinking\b/.test(out)) throw new Error('sequentialthinking not enabled in docker mcp')
  return 'context7 + sequentialthinking enabled'
})

await check('docker mcp tools', () => {
  const out = run('docker mcp tools ls')
  if (!/\bresolve-library-id\b/.test(out)) throw new Error('resolve-library-id tool missing')
  if (!/\bget-library-docs\b/.test(out)) throw new Error('get-library-docs tool missing')
  if (!/\bsequentialthinking\b/.test(out)) throw new Error('sequentialthinking tool missing')
  return 'tools visible'
})

summarize()
