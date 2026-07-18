#!/usr/bin/env bun
import { greet, logger, VERSION } from "@kagchi/robochi-core";

logger.info(`Robochi CLI v${VERSION}`);

const name = process.argv[2] || "World";
console.log(greet(name));
