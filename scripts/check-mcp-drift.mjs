#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []

function fail(message) {
  failures.push(message)
}

function readJson(filePath) {
  const absolute = path.resolve(root, filePath)
  const raw = fs.readFileSync(absolute, 'utf8')
  return JSON.parse(raw)
}

function readText(filePath) {
  const absolute = path.resolve(root, filePath)
  return fs.readFileSync(absolute, 'utf8')
}

function validateDockerServer(server, imageName, label) {
  const expectedArgs = ['run', '-i', '--rm', imageName]
  if (!server || typeof server !== 'object') {
    fail(`${label} missing`)
    return
  }
  if (server.type !== 'stdio') fail(`${label} must use stdio`)
  if (server.command !== 'docker') fail(`${label} must use docker command`)
  if (JSON.stringify(server.args || []) !== JSON.stringify(expectedArgs)) {
    fail(`${label} args mismatch; expected ${JSON.stringify(expectedArgs)}`)
  }
}

function validateServersObject(servers, fileLabel) {
  if (!servers || typeof servers !== 'object') {
    fail(`${fileLabel} missing server object`)
    return
  }

  const keys = Object.keys(servers).sort()
  const expectedKeys = ['context7', 'memory', 'sequentialthinking']
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    fail(`${fileLabel} server keys mismatch; expected ${expectedKeys.join(', ')} got ${keys.join(', ')}`)
  }

  const memory = servers.memory
  if (!memory) {
    fail(`${fileLabel} missing memory server`)
  } else {
    if (memory.type !== 'sse') fail(`${fileLabel} memory must use sse`)
    const pattern = /^http:\/\/localhost:8765\/mcp\/[a-zA-Z0-9_-]+\/sse\/[a-zA-Z0-9_-]+$/
    if (!pattern.test(memory.url || '')) {
      fail(`${fileLabel} memory url must match OpenMemory SSE format`)
    }
  }

  validateDockerServer(servers.context7, 'mcp/context7', `${fileLabel} context7`)
  validateDockerServer(servers.sequentialthinking, 'mcp/sequentialthinking', `${fileLabel} sequentialthinking`)
}

try {
  const vscode = readJson('.vscode/mcp.json')
  validateServersObject(vscode.servers, '.vscode/mcp.json')

  const vscodeRaw = readText('.vscode/mcp.json')
  if (vscodeRaw.includes('MCP_DOCKER')) fail('.vscode/mcp.json should not contain MCP_DOCKER')
  if (vscodeRaw.includes('@modelcontextprotocol/server-memory')) {
    fail('.vscode/mcp.json should not contain legacy server-memory stdio config')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  fail(`failed to validate .vscode/mcp.json: ${message}`)
}

const projectMcpPath = path.resolve(root, '.mcp.json')
if (fs.existsSync(projectMcpPath)) {
  try {
    const project = readJson('.mcp.json')
    validateServersObject(project.mcpServers, '.mcp.json')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`failed to validate .mcp.json: ${message}`)
  }
}

try {
  const agents = readText('AGENTS.md')
  if (!agents.includes('### Project MCP Baseline')) {
    fail('AGENTS.md missing Project MCP Baseline section')
  }
  if (!agents.includes('`memory` (OpenMemory SSE)')) {
    fail('AGENTS.md missing memory baseline line')
  }
  if (!agents.includes('`context7` (Docker server)')) {
    fail('AGENTS.md missing context7 baseline line')
  }
  if (!agents.includes('`sequentialthinking` (Docker server)')) {
    fail('AGENTS.md missing sequentialthinking baseline line')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  fail(`failed to validate AGENTS.md: ${message}`)
}

try {
  const architecture = readText('ARCHITECTURE.md')
  if (!architecture.includes('## AI Tooling Baseline (MCP)')) {
    fail('ARCHITECTURE.md missing AI Tooling Baseline (MCP) section')
  }
  if (!architecture.includes('`context7`')) fail('ARCHITECTURE.md missing context7 mention in MCP baseline')
  if (!architecture.includes('`sequentialthinking`')) {
    fail('ARCHITECTURE.md missing sequentialthinking mention in MCP baseline')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  fail(`failed to validate ARCHITECTURE.md: ${message}`)
}

try {
  const claude = readText('CLAUDE.md')
  if (!claude.includes('OpenMemory SSE')) {
    fail('CLAUDE.md must reference OpenMemory SSE')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  fail(`failed to validate CLAUDE.md: ${message}`)
}

if (failures.length > 0) {
  console.error('MCP drift check failed:')
  for (const message of failures) {
    console.error(`- ${message}`)
  }
  process.exit(1)
}

console.log('MCP drift check passed.')
