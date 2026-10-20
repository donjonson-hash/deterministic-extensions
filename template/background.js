'use strict';
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({url: chrome.runtime.getURL('app.html')});
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.tabs.create({url: chrome.runtime.getURL('welcome.html')});
});
