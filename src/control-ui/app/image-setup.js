'use strict';
// Image viewer and project path picker setup: they open in the shared modal and read files through the API.
window.AIWSImages?.configureViewer((...args)=>showModal(...args));
window.AIWSImages?.configurePaths({api,projectId:()=>projectId||undefined,onError:error=>toast(error.message)});
