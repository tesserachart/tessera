export function threadMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}
