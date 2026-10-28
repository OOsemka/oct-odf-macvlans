type YamlValue = string | number | boolean | null | undefined | YamlValue[] | { [key: string]: YamlValue };

function isScalar(val: YamlValue): boolean {
  return val === null || val === undefined || typeof val !== 'object';
}

function quoteIfNeeded(value: string): string {
  if (
    value === '' ||
    value === 'true' || value === 'false' ||
    value === 'null' || value === 'yes' || value === 'no' ||
    /[:#\[\]{}&*!|>'"@`,%]/.test(value) ||
    /^\d+(\.\d+)?$/.test(value)
  ) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function scalarToString(value: YamlValue): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return quoteIfNeeded(value);
  return String(value);
}

function renderLines(value: YamlValue, indent: number): string[] {
  const pad = '  '.repeat(indent);

  if (isScalar(value)) {
    return [scalarToString(value)];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];

    const lines: string[] = [];
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${scalarToString(item)}`);
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        for (const sub of renderLines(item, indent + 1)) {
          lines.push(sub);
        }
      } else {
        const obj = item as Record<string, YamlValue>;
        const entries = Object.entries(obj);
        entries.forEach(([key, val], idx) => {
          const prefix = idx === 0 ? `${pad}- ` : `${pad}  `;
          if (isScalar(val)) {
            lines.push(`${prefix}${key}: ${scalarToString(val)}`);
          } else {
            lines.push(`${prefix}${key}:`);
            const childPad = '  '.repeat(indent + 2);
            for (const sub of renderValue(val, indent + 2)) {
              lines.push(sub.startsWith(childPad) ? sub : `${childPad}${sub}`);
            }
          }
        });
      }
    }
    return lines;
  }

  const obj = value as Record<string, YamlValue>;
  const lines: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (isScalar(val)) {
      lines.push(`${pad}${key}: ${scalarToString(val)}`);
    } else {
      lines.push(`${pad}${key}:`);
      for (const sub of renderValue(val, indent + 1)) {
        lines.push(sub);
      }
    }
  }
  return lines;
}

function renderValue(value: YamlValue, indent: number): string[] {
  if (isScalar(value)) {
    return [scalarToString(value)];
  }
  return renderLines(value, indent);
}

export function toYaml(obj: Record<string, unknown>): string {
  return renderLines(obj as Record<string, YamlValue>, 0).join('\n') + '\n';
}
