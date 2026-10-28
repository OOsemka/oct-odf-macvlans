type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function sendLog(level: LogLevel, action: string, message: string, details?: string) {
  const line = `[oct-odf-macvlans] ${level} ${action}: ${message}${details ? ` (${details})` : ''}`;
  if (level === 'ERROR') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.debug(line);
  }
}

const dashboardLogger = {
  info: (action: string, message: string, details?: string) => sendLog('INFO', action, message, details),
  warn: (action: string, message: string, details?: string) => sendLog('WARN', action, message, details),
  error: (action: string, message: string, details?: string) => sendLog('ERROR', action, message, details),
};

export default dashboardLogger;
