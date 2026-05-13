export interface PortScheme {
  basePort: number;
  portStep: number;
  maxSlotCount: number;
  minPort: number;
  maxPort: number;
}

export interface PortSchemeOptions {
  basePort: number;
  portStep?: number;
  maxSlotCount?: number;
}

export function resolvePortScheme(opts: PortSchemeOptions): PortScheme {
  const portStep = opts.portStep ?? 10;
  const maxSlotCount = opts.maxSlotCount ?? 19;
  const basePort = opts.basePort;
  return {
    basePort,
    portStep,
    maxSlotCount,
    minPort: basePort + portStep,
    maxPort: basePort + maxSlotCount * portStep,
  };
}

export function isValidPort(port: number, scheme: PortScheme): boolean {
  return (
    Number.isInteger(port) &&
    port >= scheme.minPort &&
    port <= scheme.maxPort &&
    (port - scheme.basePort) % scheme.portStep === 0
  );
}

export function allPorts(scheme: PortScheme): number[] {
  const ports: number[] = [];
  for (let p = scheme.minPort; p <= scheme.maxPort; p += scheme.portStep) {
    ports.push(p);
  }
  return ports;
}

export function defaultComputePorts(portNames: string[]): (slot: number) => Record<string, number> {
  if (portNames.length === 0) {
    throw new Error("portNames must not be empty");
  }
  return (slot: number) => {
    const out: Record<string, number> = {};
    portNames.forEach((name, i) => {
      out[name] = slot + i;
    });
    return out;
  };
}
