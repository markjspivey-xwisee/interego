export function modalDistribution(input) {
  const counts = { Asserted: 0, Hypothetical: 0, Counterfactual: 0, other: 0, total: 0 };
  if (!input) return counts;
  for (const line of input.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const status = obj.modalStatus;
    if (status === 'Asserted' || status === 'Hypothetical' || status === 'Counterfactual') {
      counts[status]++;
    } else {
      counts.other++;
    }
    counts.total++;
  }
  return counts;
}
