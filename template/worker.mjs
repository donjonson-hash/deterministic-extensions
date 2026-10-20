import {compareDocuments} from './core/comparison.mjs';

self.onmessage = event => {
  const {ticket, a, b, policy} = event.data;
  try {
    self.postMessage({ticket, report: compareDocuments(a, b, policy)});
  } catch (error) {
    self.postMessage({ticket, error: error.message || 'Comparison rejected.'});
  }
};
