# Replay HAR files directly from k6

This repository contains a k6 javascript module that lets you directly replay [HAR](https://en.wikipedia.org/wiki/HAR_(file_format)) files from your k6 suite. Uses the HTTP load testing mechanism, not browser testing.

## Usage

```js
// check the Github releases page for the latest release
import HARDocument from 'https://github.com/martin-helmich/k6-har/releases/download/v0.1.1/k6-har.js';

export const options = {
    // relevant, since resources will be requested in batches
    batch: 20,
    batchPerHost: 5,
    
    // might be necessary for higher-volume tests, or when your HAR contains
    // large responses (like large images)
    discardResponseBodies: true,
    
    vus: 1,
    duration: '10s',
    
    // requests will have a "resource_type" tag that you can select on in your
    // thresholds:
    thresholds: {
        'http_req_duration{resource_type:document}': ['p(95)<500'],
        'http_req_duration{resource_type:stylesheet}': ['p(95)<100']
    }
};

let indexHar = HARTest.fromFile("example.har");

export default function() {
    indexHar.run();
}

```