const state = {
  syncdns: {
    results: [
      { domain: 'test.com', status: 'pending', message: 'En cola' }
    ]
  }
};

function getState() {
  return { ...state.syncdns };
}

function update(changes) {
  state.syncdns = { ...state.syncdns, ...changes };
}

function updateDomainState(domain, status, message) {
  const st = getState();
  if (st && Array.isArray(st.results)) {
    const idx = st.results.findIndex(r => r.domain === domain);
    if (idx >= 0) {
      st.results[idx] = { domain, status, message };
    } else {
      st.results.push({ domain, status, message });
    }
    update({ results: st.results });
  }
}

console.log("Initial:", JSON.stringify(state));
updateDomainState('test.com', 'processing', 'Processing...');
console.log("Processing:", JSON.stringify(state));
updateDomainState('test.com', 'success', 'Success!');
console.log("Success:", JSON.stringify(state));
