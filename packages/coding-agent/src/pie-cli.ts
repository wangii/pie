#!/usr/bin/env node

// Preserve dependency order: bootstrap the application identity before the
// shared CLI evaluates config and starts Pie on Pi's execution chassis.
import "./pie-bootstrap.ts";
import "./cli.ts";
