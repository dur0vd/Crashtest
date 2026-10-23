#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';
const { main } = await tsImport('./verify.ts', import.meta.url);
// Integrated build: recalculation uses the real physics and rules ports.
const { createPorts, currentVersions } = await tsImport('./ports.ts', import.meta.url);
process.exitCode = await main(process.argv.slice(2), createPorts(), await currentVersions());
