"use strict";
//console.time("start");
//Project Alchemy
//Devel
//Copyright 2019 - 2024 Christian Lockley

const { ipcRenderer, __dirname, bibleAPI, webUtils } = window.electron;

var dontSyncRemote = false;
var pidSeeking = false;
var mediaPlayDelay = null;
var video = null;
var masterPauseState = false;
var activeLiveStream = false;
var targetTime = 0;
var startTime = 0;
var prePathname = '';
var savedCurTime = '';
var playingMediaAudioOnly = false;
var audioOnlyFile = false;
var mediaCntDnEle = null;
var CrVL = 1;
var opMode = -1;
var osName = navigator.userAgentData.platform;
var localTimeStampUpdateIsRunning = false;
var mediaFile;
var currentMediaFile;
var fileEnded = false;
var dyneForm = null;
var mediaSessionPause = false;
let isPlaying = false;
const MEDIAPLAYER = 0, MEDIAPLAYERYT = 1, BULKMEDIAPLAYER = 5, TEXTPLAYER = 6;
const imageRegex = /\.(bmp|gif|jpe?g|png|webp|svg|ico)$/i;
let isActiveMediaWindowCache = false;

class PIDController {
    constructor(video) {
        this.video = video;
        this.isOscillating = false;
        this.lastCrossing = 0;
        this.numberOfCrossings = 0;
        this.accumulatedPeriod = 0;
        this.significantErrorThreshold = 0.1;
        this.decayFactor = 0.9;
        this.maxAllowedPeriod = 5000;
        this.lastError = 0;
        this.integral = 0;
        this.lastTimeDifference = 0;
        this.kP = 0.005; // Proportional gain
        this.kI = 0.001; // Integral gain
        this.kD = 0.003; // Derivative gain
        this.synchronizationThreshold = 0.01;
        this.lastUpdateTime = 0;
    }

    reset() {
        this.isOscillating = false;
        this.lastCrossing = 0;
        this.numberOfCrossings = 0;
        this.accumulatedPeriod = 0;
        this.lastError = 0;
        this.integral = 0;
        this.lastTimeDifference = 0;
    }

    adjustPlaybackRate(targetTime) {
        const timeDifference = targetTime - this.video.currentTime;
        this.integral += timeDifference; // Accumulate the error
        this.lastTimeDifference = timeDifference;

        let playbackRate;
        let minRate = 0.8;
        let maxRate = 1.2;
        const timeDifferenceAbs = timeDifference < 0 ? -timeDifference : timeDifference;

        if (timeDifferenceAbs > 0.5) {
            this.integral = 0;
            minRate = 0.5;
            maxRate = 1.5;
        }

        if (timeDifferenceAbs > 1 || timeDifference < -1) {
            pidSeeking = true;
            this.video.currentTime = targetTime;
            playbackRate = 1.0;
            this.adjustPID(timeDifference);
        } else {
            playbackRate = this.video.playbackRate + (this.kP * timeDifference) + (this.kI * this.integral) + (this.kD * (timeDifference - this.lastTimeDifference));
            playbackRate = playbackRate < minRate ? minRate : playbackRate;
            playbackRate = playbackRate > maxRate ? maxRate : playbackRate;
        }

        if (playbackRate === playbackRate) {
            this.video.playbackRate = playbackRate;
        }

        if (timeDifferenceAbs <= this.synchronizationThreshold) {
            this.video.playbackRate = 1.0;
        }

        return timeDifference;
    }

    adjustPID(currentError) {
        const now = performance.now();
        const period = now - this.lastCrossing;
        const absError = currentError < 0 ? -currentError : currentError;

        if (absError < this.significantErrorThreshold && currentError * this.lastError < 0) {
            if (this.isOscillating) {
                this.accumulatedPeriod = this.accumulatedPeriod * this.decayFactor + period * (1 - this.decayFactor);
                this.numberOfCrossings = this.numberOfCrossings * this.decayFactor + 1;
                this.lastCrossing = now;

                if (this.numberOfCrossings >= 5) {
                    const averagePeriod = this.accumulatedPeriod / this.numberOfCrossings;
                    const Tu = averagePeriod;
                    const Ku = this.kP;

                    this.kP = this.kP * (1 - 0.1) + 0.1 * (0.6 * Ku);
                    this.kI = this.kI * (1 - 0.1) + 0.1 * (2 * this.kP / Tu);
                    this.kD = this.kD * (1 - 0.1) + 0.1 * (this.kP * Tu / 8);

                    this.isOscillating = false;
                    this.numberOfCrossings = 0;
                    this.accumulatedPeriod = 0;
                }
            }
        } else {
            if (!this.isOscillating) {
                this.kP += 0.01 * (absError > 1 ? 2 : 1);
                this.isOscillating = true;
            }
        }

        if (this.numberOfCrossings < 5 && period > this.maxAllowedPeriod) {
            this.kP += 0.05;
            this.lastCrossing = now;
            this.isOscillating = true;
        }

        this.lastError = currentError;
    }
}

let pidController;

const pad = (n) => (n < 10 ? '0' : '') + n;
const padMs = (n) => (n < 10 ? '00' : n < 100 ? '0' : '') + n;

function secondsToTime(seconds) {
    const wholeSecs = seconds | 0;
    const ms = ((seconds - wholeSecs) * 1000 + 0.5) | 0;
    const h = (wholeSecs / 3600) | 0;
    const m = ((wholeSecs / 60) | 0) % 60;
    const s = wholeSecs % 60;

    return `${pad(h)}:${pad(m)}:${pad(s)}.${padMs(ms)}`;
}

function isActiveMediaWindow() {
    return isActiveMediaWindowCache;
}

let lastUpdateTimeLocalPlayer = 0;

const basename = (input) => {
    const match = input.match(/^(?:https?:\/\/)?(?:www\.)?([^/]+)/);

    if (match) {
        return match[1];
    } else {
        return input.split(/[/\\]/).pop();
    }
};

function addFilenameToTitlebar(path) {
    document.title = basename(path) + " - EJaxMediaSystem";
}

function removeFilenameFromTitlebar() {
    document.title = "EJaxMediaSystem";
}

function update(time) {
    if (time - lastUpdateTimeLocalPlayer >= 33.33) {
        if (mediaCntDnEle && audioOnlyFile) {
            mediaCntDnEle.textContent = secondsToTime(video.duration - video.currentTime);
        } else {
            localTimeStampUpdateIsRunning = false;
            return;
        }
        lastUpdateTimeLocalPlayer = time;
    }
    if (!video.paused) {
        requestAnimationFrame(update);
    } else {
        localTimeStampUpdateIsRunning = false;
    }
}

function updateTimestamp(oneShot) {
    if (oneShot && mediaCntDnEle) {
        mediaCntDnEle.textContent = secondsToTime(video.duration - video.currentTime);
        return;
    }

    if (localTimeStampUpdateIsRunning) {
        return;
    }

    if (!mediaCntDnEle) {
        localTimeStampUpdateIsRunning = false;
        return;
    }

    if (playingMediaAudioOnly || !video.paused) {
        localTimeStampUpdateIsRunning = true;
        if (!video.paused) {
            requestAnimationFrame(update);
        } else {
            localTimeStampUpdateIsRunning = false;
        }
    }
}

let currentMessage = null;

function updateTimestampUI() {
    mediaCntDnEle.textContent = currentMessage;
    currentMessage = null;
}

const boundUpdateTimestampUI = updateTimestampUI.bind();

function handleTimeMessage(_, message) {
    const now = Date.now();

    if (opMode === MEDIAPLAYER) {
        currentMessage = message[0];
        requestAnimationFrame(boundUpdateTimestampUI);
    }

    targetTime = message[2] - (((now - message[3]) + (Date.now() - now)) * .001);
    message = null;
    if (now - this.lastUpdateTime > 0.5) {
        if (!video.paused && video !== null && !video.seeking) {
            hybridSync(targetTime);
            this.lastUpdateTime = now;
        }
    }
}

function installIPCHandler() {
    ipcRenderer.on('timeRemaining-message', handleTimeMessage);

    ipcRenderer.on('update-playback-state', async (event, playbackState) => {
        if (!video) {
            return;
        }
        if (playbackState.playing && video.paused) {
            masterPauseState = false;
            if (video && !isImg(mediaFile)) {
                await video.play();
            }
        } else if (!playbackState.playing && !video.paused) {
            masterPauseState = true;
            if (video) {
                video.currentTime = playbackState.currentTime;
                await video.pause();
            }
        }
    });

    ipcRenderer.on('remoteplaypause', (_, arg) => {
        mediaSessionPause = arg;
    });

    ipcRenderer.on('media-window-closed', handleMediaWindowClosed);
}

function handleMediaWindowClosed(event, id) {
    isPlaying = false;
    updatePlayButtonUI();
    isActiveMediaWindowCache = false;

    let isImgFile = isImg(mediaFile);
    handleMediaPlayback(isImgFile);

    let imgEle = document.querySelector('img');
    handleImageDisplay(isImgFile, imgEle);

    resetVideoState();
    resetMediaCountdown();

    updatePlayButtonOnMediaWindow();
    masterPauseState = false;
    saveMediaFile();
    removeFilenameFromTitlebar();
}

function handleMediaPlayback(isImgFile) {
    if (!isImgFile) {
        if (video.src !== window.location.href) {
            waitForMetadata().then(() => {
                audioOnlyFile = (opMode === MEDIAPLAYER && video.videoTracks && video.videoTracks.length === 0);
            });
        }
        video.src = mediaFile;
    }
}

function handleImageDisplay(isImgFile, imgEle) {
    if (imgEle && !isImgFile) {
        imgEle.remove();
        document.getElementById("preview").style.display = '';
        document.getElementById("cntdndiv").style.display = '';
    } else if (isImgFile) {
        if (imgEle) {
            imgEle.src = mediaFile;
        } else {
            if ((imgEle = document.querySelector('img')) !== null) {
                imgEle.remove();
                document.getElementById("cntdndiv").style.display = '';
            }
            video.src = '';
            img = document.createElement('img');
            img.src = mediaFile;
            img.setAttribute("id", "preview");
            if (!document.getElementById("preview")) {
                document.getElementById("preview").style.display = 'none';
            }
            document.getElementById("preview").parentNode.appendChild(img);
            document.getElementById("cntdndiv").style.display = 'none';
        }
    }
}

function resetVideoState() {
    if (video !== null) {
        video.muted = true;
        video.pause();
        video.currentTime = 0;
        targetTime = 0;
    }
}

function resetMediaCountdown() {
    const mediaCntDn = document.getElementById("mediaCntDn");
    if (mediaCntDn !== null) {
        mediaCntDn.innerText = "00:00:00.000";
    }
}

function updatePlayButtonOnMediaWindow() {
    const playButton = document.getElementById("mediaWindowPlayButton");
    if (playButton !== null) {
        updatePlayButtonUI();
    } else {
        document.getElementById("MdPlyrRBtnFrmID").addEventListener("click", updatePlayButtonUI, { once: true });
    }
}

function resetPIDOnSeek() {
    if (pidController) {
        pidController.integral = 0;
        pidController.lastTimeDifference = 0;
    }
}

function hybridSync(targetTime) {
    if (audioOnlyFile) return;
    if (!activeLiveStream) {
        pidController.adjustPID(pidController.adjustPlaybackRate(targetTime));
    }
}

function isImg(pathname) {
    return imageRegex.test(pathname);
}

function vlCtl(v) {
    if (!audioOnlyFile) {
        ipcRenderer.send('vlcl', v, 0);
    } else {
        video.volume = v;
    }
}

async function pauseMedia(e) {
    if (activeLiveStream) {
        await ipcRenderer.send('play-ctl', 'pause');
        return;
    }
    if (video.src === window.location.href || video.readyState === 0) {
        return;
    }

    if (!playingMediaAudioOnly) {
        await ipcRenderer.send('play-ctl', 'pause');
        ipcRenderer.invoke('get-media-current-time').then(r => { targetTime = r });
    }
    resetPIDOnSeek();
}

async function unPauseMedia(e) {
    if (activeLiveStream) {
        await ipcRenderer.send('play-ctl', 'play');
        return;
    }
    if (video.src === window.location.href || video.readyState === 0) {
        return;
    }

    if (!playingMediaAudioOnly && e !== null && e !== undefined && e.target.isConnected) {
        resetPIDOnSeek();
        await ipcRenderer.send('play-ctl', 'play');
    }
    if (playingMediaAudioOnly && document.getElementById("mediaWindowPlayButton")) {
        updatePlayButtonUI();
    }
}

function handleCanPlayThrough(e, resolve) {
    if (video.src === window.location.href) {
        e.preventDefault();
        resolve(video);
        return;
    }
    video.currentTime = 0;
    audioOnlyFile = video.videoTracks && video.videoTracks.length === 0;
    resolve(video);
}

function handleError(e, reject) {
    reject(e);
}

function waitForMetadata() {
    if (!video || !video.src || video.src === window.location.href || isLiveStream(video.src) || isImg(video.src)) {
        playingMediaAudioOnly = false;
        audioOnlyFile = false;
        return Promise.reject("Invalid source or live stream.");
    }

    return new Promise((resolve, reject) => {
        const onCanPlayThrough = (e) => handleCanPlayThrough(e, resolve);
        const onError = (e) => handleError(e, reject);

        video.addEventListener('canplaythrough', onCanPlayThrough, { once: true });
        video.addEventListener('error', onError, { once: true });

        if (video.readyState === 0) {
            video.load();
        }
    });
}

function playMedia(e) {
    if (e === undefined && audioOnlyFile && opMode === MEDIAPLAYER) {
        e = {};
        e.target = document.getElementById("mediaWindowPlayButton");
    }
    fileEnded = false;
    if (opMode === MEDIAPLAYER && encodeURI(mediaFile) !== removeFileProtocol(video.src)) {
        saveMediaFile();
    }

    const mdFIle = document.getElementById("mdFile");

    if (isPlaying === false && mdFIle.value === "" && opMode !== MEDIAPLAYER) {
        return;
    }

    if (mdFIle.value === "" && !playingMediaAudioOnly) {
        if (isPlaying) {
            isPlaying = false;
            ipcRenderer.send('close-media-window', 0);
            saveMediaFile();
            video.currentTime = 0;
            video.pause();
            isPlaying = false;
            updatePlayButtonUI();
            localTimeStampUpdateIsRunning = false;
            return;
        } else if (!isPlaying && video.src !== null && video.src !== '' && saveMediaFile.fileInpt != null) {
            let t1 = encodeURI(saveMediaFile.fileInpt[0].name);
            let t2 = removeFileProtocol(video.src).split(/[\\/]/).pop();
            if (t1 == null || t2 == null || t1 !== t2) {
                return;
            } else {
                mdFIle.files = saveMediaFile.fileInpt;
            }
        } else {
            return;
        }
    }

    if (!isPlaying) {
        isPlaying = true;
        updatePlayButtonUI()
        if (opMode === MEDIAPLAYER) {
            if (isImg(mediaFile)) {
                createMediaWindow();
                video.currentTime = 0;
                if (!video.paused)
                    video.src = '';
                return;
            }
        }
        let mdly = document.getElementById("mdDelay");
        if (audioOnlyFile) {
            ipcRenderer.send("localMediaState", 0, "play");
            addFilenameToTitlebar(mediaFile);
            isPlaying = true;
            video.muted = false;
            video.loop = document.getElementById("mdLpCtlr").checked;
            playingMediaAudioOnly = true;
            currentMediaFile = mdFIle.files;
            if (audioOnlyFile && mdly !== null && mdly.value > 0) {
                mediaPlayDelay = setTimeout(playAudioFileAfterDelay, mdly.value * 1000);
                return;
            }
            video.play();
            updateTimestamp(false);
            return;
        }

        currentMediaFile = mdFIle.files;
        if (opMode === MEDIAPLAYER && document.getElementById("malrm1").value !== "") {
            var deadlinestr = "";
            var deadlinestrarr = String(new Date()).split(" ");
            deadlinestrarr[4] = document.getElementById("malrm1").value;
            for (let i = 0; i < deadlinestrarr.length; ++i) { deadlinestr += (deadlinestrarr[i] + " ") }
            deadline = new Date(deadlinestr);
            mdly.value = ((deadline.getTime() - new Date().getTime()) / 1000);
        }
        if (mdly !== null && mdly.value > 0) {
            mediaPlayDelay = setTimeout(createMediaWindow, mdly.value * 1000);
        } else {
            createMediaWindow();
        }
        dontSyncRemote = false;
    } else {
        isPlaying = false;
        updatePlayButtonUI();
        ipcRenderer.send('close-media-window', 0);
        playingMediaAudioOnly = false;
        dontSyncRemote = true;
        clearTimeout(mediaPlayDelay);
        if (opMode === MEDIAPLAYER)
            document.getElementById('mediaCntDn').textContent = "00:00:00.000";
        if (!audioOnlyFile)
            activeLiveStream = true;
        video.pause();
        video.currentTime = 0;
        if (audioOnlyFile) {
            ipcRenderer.send("localMediaState", 0, "stop");
            removeFilenameFromTitlebar();
            activeLiveStream = false;
            saveMediaFile();
            if (opMode === MEDIAPLAYER)
                document.getElementById('mediaCntDn').textContent = "00:00:00.000";
            if (video) {
                video.muted = true;
            }
            audioOnlyFile = false;
        }
        localTimeStampUpdateIsRunning = false;
        waitForMetadata().then(saveMediaFile);
    }
    updatePlayButtonUI();
}

function updatePlayButtonUI() {
    const playButton = document.getElementById("mediaWindowPlayButton");
    if (playButton) {
        playButton.textContent = isPlaying ? "Stop Presentation" : "Start Presentation";
    }
}

function setSBFormYouTubeMediaPlayer() {
    if (opMode === MEDIAPLAYERYT) {
        return;
    }
    opMode = MEDIAPLAYERYT;
    ipcRenderer.send('set-mode', opMode);

    if (!isActiveMediaWindow()) {
        if (document.getElementById("mediaCntDn") !== null) {
            document.getElementById("mediaCntDn").textContent = "00:00:00.000";
        }
    }

    dyneForm.innerHTML =
        `
        <form onsubmit="return false;">
        <input type="url" name="mdFile" id="mdFile" placeholder="Paste your video URL here..." style="width: 80%; padding: 15px; font-size: 16px; border: 2px solid #ddd; border-radius: 8px; outline: none;" onfocus="this.style.borderColor='#0056b3';" onblur="this.style.borderColor='#ddd';" accept="video/mp4,video/x-m4v,video/*,audio/x-m4a,audio/*">
        <br>
            <button id="mediaWindowPlayButton" type="button">▶️</button>
        <br>
            <select name="dspSelct" id="dspSelct">
                <option value="" disabled>--Select Display Device--</option>
            </select>
            <br>
            <br>
        </form>
        <br>
    `;

    /*const vc = document.getElementById('volumeControl');
    vc.addEventListener('input', handleVolumeChange);
    vc.value = CrVL;*/

    if (mediaFile !== null && isLiveStream(mediaFile)) {
        document.getElementById("mdFile").value = mediaFile;
    }

    ipcRenderer.invoke('get-all-displays').then(displays => {
        for (let i = 0; i < displays.length; i++) {
            var el = document.createElement("option");
            let dspSelct = document.getElementById("dspSelct");
            el.textContent = `Display ${i + 1} ${displays[i].bounds.width}x${displays[i].bounds.height}`;
            dspSelct.appendChild(el);

            if (dspSelct.options.length > 2) {
                dspSelct.selectedIndex = 2; // Hardcode 2nd option
            } else if (dspSelct.options.length === 2) {
                dspSelct.selectedIndex = 1;
            }
        }
    });

    document.getElementById("mediaWindowPlayButton").addEventListener("click", playMedia);

    if (playingMediaAudioOnly) {
        isPlaying = true;
        updatePlayButtonUI();
        return;
    }
    restoreMediaFile();

    if (document.getElementById("mdFile").value.includes(":\\fakepath\\")) {
        document.getElementById("mdFile").value = '';
    }

    if (!isActiveMediaWindow()) {
        isPlaying = false;
    } else {
        isPlaying = true;
    }
    updatePlayButtonUI();
}


async function setSBFormTextPlayer() {
    if (opMode === TEXTPLAYER) {
        return;
    }
    opMode = TEXTPLAYER;
    ipcRenderer.send('set-mode', opMode);

    dyneForm.innerHTML = `
        <form onsubmit="return false;">
            <label for="scriptureInput">Scripture:</label>
            <input type="text" id="scriptureInput" class="input-field" placeholder="e.g., Genesis 1:1">
            <ul id="bookSuggestions" style="list-style-type: none; padding: 0; margin-top: 5px; border: 1px solid #ccc; background-color: white; width: 200px; position: absolute; display: none; max-height: 200px; overflow-y: auto;"></ul>
            <div id="versesDisplay" style="width: 1200px;height: 200px; overflow-y: scroll; background-color: #f8f8f8; padding: 10px;"></div>
        </form>
    `;

    const scriptureInput = document.getElementById('scriptureInput');
    const versesDisplay = document.getElementById('versesDisplay');
    const bookSuggestions = document.getElementById('bookSuggestions');
    if (setSBFormTextPlayer.bibleAPIInit == undefined) {
        await bibleAPI.init();
        setSBFormTextPlayer.bibleAPIInit = true;
    }
    const books = bibleAPI.getBooks().sort((a, b) => a.name.localeCompare(b.name));
    const booksById = bibleAPI.getBooks().sort((a, b) => a.id - b.id);

    let selectedIndex = -1;

    scriptureInput.addEventListener('input', function (event) {
        const value = this.value.trim();
        updateBookSuggestions(value);
    });

    scriptureInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault(); // Prevent form submission
            if (selectedIndex >= 0 && bookSuggestions.children[selectedIndex]) {
                bookSuggestions.children[selectedIndex].click();
            } else {
                scriptureInput.value = normalizeScriptureReference(scriptureInput.value);
                updateVersesDisplay();
            }
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (selectedIndex < bookSuggestions.children.length - 1) {
                selectedIndex++; // Increment to move down in the list
                updateSuggestionsHighlight();
            }
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (selectedIndex > 0) {
                selectedIndex--; // Decrement to move up in the list
                updateSuggestionsHighlight();
            }
        }
    });

    function updateSuggestionsHighlight() {
        Array.from(bookSuggestions.children).forEach((item, index) => {
            if (index === selectedIndex) {
                item.classList.add('highlight');
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // Ensure the highlighted item is visible
            } else {
                item.classList.remove('highlight');
            }
        });
    }

    let lastHighlighted = null;

    scriptureInput.addEventListener('input', function (event) {
        const value = this.value.trim();
        updateBookSuggestions(value, event);
    });

    scriptureInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            scriptureInput.value = normalizeScriptureReference(scriptureInput.value)
            event.preventDefault(); // Prevent the default form submission
            updateVersesDisplay();
        }
    });

    function normalizeScriptureReference(input) {
        let parts = input.split(' ');
        let normalizedParts = [];

        for (let i = 0; i < parts.length; ++i) {
            let part = parts[i];
            if (part.includes(':')) {
                let subParts = part.split(':');
                subParts = subParts.filter(Boolean);
                normalizedParts.push(subParts.join(':'));
            } else {
                normalizedParts.push(part);
            }
        }

        return normalizedParts.join(' ');
    }

    function parseScriptureReference(input) {
        let tokens = input.split(/\s+/);
        let book = "";
        let chapter = undefined;
        let verse = undefined;

        // Process each token and determine if it's a number or part of a book name
        tokens.forEach((token, index) => {
            if (token.includes(":")) {
                // Handle chapter and verse notation
                const parts = token.split(":");
                chapter = parseInt(parts[0], 10);  // Assume the part before ':' is chapter
                verse = parseInt(parts[1], 10);    // Assume the part after ':' is verse
            } else if (!isNaN(parseInt(token)) && index === tokens.length - 1) {
                // Last token is a number and no verse has been defined, assume it's a chapter
                chapter = parseInt(token, 10);
            } else {
                // Append to book name
                book = book ? `${book} ${token}` : token;
            }
        });

        return { book, chapter, verse };
    }

    function splitOnLastSpace(input) {
        let lastIndex = input.lastIndexOf(' ');

        if (lastIndex === -1) {
            return [input]; // Return the whole string as an array if no space found
        }

        let firstPart = input.substring(0, lastIndex);
        let lastPart = input.substring(lastIndex + 1);

        return [firstPart, lastPart];
    }

    function updateBookSuggestions(input, event) {
        let parts = input.split(/[\s:]+/);
        let bookPart = input.match(/^\d?\s?[a-zA-Z]+/); // Matches any leading number followed by book names
        bookPart = bookPart ? bookPart[0].trim() : ""; // Ensure the match is not null and trim it
        bookSuggestions.innerHTML = '';
        const filteredBooks = books.filter(book =>
            book.name.toLowerCase().startsWith(bookPart.toLowerCase())
        );
        if (filteredBooks.length) {
            if (filteredBooks.length === 1) {
                if (splitOnLastSpace(scriptureInput.value)[0] === filteredBooks[0].name) {
                    return;
                }

                if (event != null && event.inputType === 'insertText') {
                    scriptureInput.value = filteredBooks[0].name + " ";
                    bookSuggestions.style.display = 'none';
                    return;
                }
            }
            bookSuggestions.style.display = 'block';
            filteredBooks.forEach(book => {
                const li = document.createElement('li');
                li.textContent = book.name;
                li.onclick = () => {
                    scriptureInput.value = book.name + (parts.length > 1 ? " " + parts.slice(1).join(" ") : " ");
                    bookSuggestions.style.display = 'none';
                    scriptureInput.focus(); // Refocus on input after selection
                    updateVersesDisplay();
                };
                bookSuggestions.appendChild(li);
            });
        } else {
            bookSuggestions.style.display = 'none';
        }
    }

    function updateVersesDisplay() {
        scriptureInput.value = normalizeScriptureReference(scriptureInput.value);
        const { book, chapter, verse } = parseScriptureReference(scriptureInput.value);

        fetchVerses(book, chapter + "", verse + "");
    }

    function fetchVerses(book, chapter, verse) {
        versesDisplay.innerHTML = ''; // Clear previous verses
        const textData = bibleAPI.getText("KJV", book, chapter);
        if (textData && textData.verses) {
            textData.verses.forEach((verseText, index) => {
                const verseNumber = index + 1;
                const p = document.createElement('p');
                p.innerHTML = `<strong>${chapter}:${verseNumber}</strong> ${verseText}`;
                p.style.cursor = 'pointer';
                p.addEventListener('dblclick', () => {
                    highlightVerse(p);
                    scriptureInput.value = `${book} ${chapter}:${verseNumber}`;
                });
                versesDisplay.appendChild(p);
                if (verse && parseInt(verse) === verseNumber) {
                    highlightVerse(p, true); // Pass true to indicate scrolling is needed
                }
            });
        }
    }

    function highlightVerse(p, scrollToView = false) {
        if (lastHighlighted) {
            lastHighlighted.style.background = ''; // Remove previous highlight
        }
        p.style.background = 'yellow'; // Highlight the new verse
        lastHighlighted = p;
        if ([scrollToView]) {
            p.scrollIntoView({ behavior: 'smooth', block: 'center' }); // Scroll to make the highlighted verse centered
        }
    }

    document.addEventListener('click', function (event) {
        if (!bookSuggestions.contains(event.target) && event.target !== scriptureInput) {
            bookSuggestions.style.display = 'none';
        }
    });
}

const isLinux = osName === "Linux";
const sliderClass = isLinux ? 'adwaita-slider' : 'WinStyle-slider';
const lineHeight = isLinux ? '1' : '1.2';

const MEDIA_FORM_HTML = `
  <form onsubmit="return false;">
    <input type="file" name="mdFile" id="mdFile" accept="video/mp4,video/x-m4v,video/*,audio/x-m4a,audio/*,image/*">
    <br>
    <input type="number" min="0" max="60" step="1" value="0" name="mdTimeout" id="mdDelay">
    <label for="mdTimeout">Start Delay</label>
    <input name="malrm1" id="malrm1" type="time">
    <label for="malrm1"> Schedule </label>
    <select name="dspSelct" id="dspSelct">
      <option value="" disabled>--Select Display Device--</option>
    </select>
    <input type="checkbox" name="mdLpCtlr" id="mdLpCtlr">
    <label for="mdLpCtlr">Loop</label>
    <br><br>
    <button id="mediaWindowPlayButton" type="button">Start Presentation</button>
    <br>
  </form>
  <br><br>
  <center><video disablePictureInPicture controls id="preview"></video></center>
  <div id="cntdndiv">
    <span id="mediaCntDn" style="
      contain: layout style;
      transform: translateX(50px);
      will-change: transform;
      top: 80%;
      transform: translate(-50%, -50%);
      color: red;
      font-weight: bold;
      font-family: 'Courier New', monospace;
      text-align: center;
      overflow: hidden;
      user-select: none;
      font-size: calc(1vw + 80%);
      line-height: ${lineHeight};">00:00:00.000</span>
  </div>
`;

function handleVolumeChange(event) {
    vlCtl(event.target.value);
    CrVL = event.target.value;
}

function setSBFormMediaPlayer() {
    if (opMode === MEDIAPLAYER) {
        return;
    }
    opMode = MEDIAPLAYER;
    ipcRenderer.send('set-mode', opMode);
    dyneForm.innerHTML = MEDIA_FORM_HTML;

    ipcRenderer.invoke('get-all-displays').then(displays => {
        const dspSelct = document.getElementById("dspSelct");
        for (let i = 0; i < displays.length; i++) {
            const el = document.createElement("option");
            el.textContent = `Display ${i + 1} ${displays[i].bounds.width}x${displays[i].bounds.height}`;
            dspSelct.appendChild(el);

            if (dspSelct.options.length > 2) {
                dspSelct.selectedIndex = 2; // Hardcode 2nd option
            } else if (dspSelct.options.length === 2) {
                dspSelct.selectedIndex = 1;
            }
        }
    });


    if (video === null) {
        video = document.getElementById('preview');
    }

    restoreMediaFile();
    updateTimestamp(false);
    /*const vc = document.getElementById('volumeControl');
    vc.addEventListener('input', handleVolumeChange);
    vc.value = CrVL;*/
    const mdFile = document.getElementById("mdFile");
    mdFile.addEventListener("change", saveMediaFile);
    const isActiveMW = isActiveMediaWindow();
    let plyBtn = document.getElementById("mediaWindowPlayButton");
    if (!isActiveMW && !playingMediaAudioOnly) {
        isPlaying = false;
        document.getElementById("mediaCntDn").textContent = "00:00:00.000";
    } else {
        isPlaying = true;
        document.getElementById('mediaCntDn').textContent = "00:00:00.000";
        if (typeof currentMediaFile === 'undefined') {
            currentMediaFile = mdFile.files
        } else {
            mdFile.files = currentMediaFile;
        }
    }
    updatePlayButtonUI();
    plyBtn.addEventListener("click", playMedia);
    dontSyncRemote = true;
    let isImgFile;
    if (mdFile !== null) {
        if (document.getElementById("preview").parentNode !== null) {
            if (!masterPauseState && video !== null && !video.paused) {
                dontSyncRemote = false;
                if (!isImg(mediaFile)) {
                    video.play();
                }
            }
            if (video !== null) {
                if (!isActiveMW) {
                    if (!mdFile.value.includes("fake")) {
                        mediaFile = mdFile.value;
                    } else {
                        mediaFile = document.getElementById("YtPlyrRBtnFrmID").checked === true ? mdFile.value : webUtils.getPathForFile(mdFile.files[0]);
                    }
                }
                const isImgFile = isImg(mediaFile);
                if (isActiveMW && mediaFile !== null && !isLiveStream(mediaFile)) {
                    if (video === null) {
                        video = document.getElementById("preview");
                        saveMediaFile();
                    }
                    if (video) {
                        if (targetTime !== null) {
                            if (!masterPauseState && !isImgFile) {
                                video.play();
                            }
                        }
                    }
                    dontSyncRemote = false;
                }
                document.getElementById("preview").parentNode.replaceChild(video, document.getElementById("preview"));
            }
        } else {
            dontSyncRemote = false;
        }

        if (isImgFile && !document.querySelector('img')) {
            img = document.createElement('img');
            video.src = '';
            img.src = mediaFile;
            img.setAttribute("id", "preview");
            document.getElementById("preview").style.display = 'none';
            document.getElementById("preview").parentNode.appendChild(img);
            document.getElementById("cntdndiv").style.display = 'none';
            return;
        }
    }
    if (encodeURI(mediaFile) !== removeFileProtocol(video.src)) {
        saveMediaFile();
    }
    //console.timeEnd("start");
}

function removeFileProtocol(filePath) {
    return filePath.slice(7);
}

function saveMediaFile() {
    const mdfileElement = document.getElementById("mdFile");
    if (!mdfileElement) {
        return;
    }

    if (mdfileElement.files !== null && mdfileElement.files.length !== 0 && encodeURI(webUtils.getPathForFile(mdfileElement.files[0])) === removeFileProtocol(video.src)) {
        return;
    }

    if (playingMediaAudioOnly && opMode === MEDIAPLAYER) {
        if (mdfileElement.files[0].length === 0) {
            return;
        }
        mediaFile = webUtils.getPathForFile(mdfileElement.files[0]);
        return;
    }

    if (mdfileElement !== null && mdfileElement !== 'undefined') {
        if (mdfileElement.files !== null && mdfileElement.files.length === 0) {
            return;
        } else if (mdfileElement.value === "") {
            return;
        }
        if (opMode !== MEDIAPLAYER && dontSyncRemote !== true)
            dontSyncRemote = true;
        saveMediaFile.fileInpt = mdfileElement.files;
        saveMediaFile.urlInpt = mdfileElement.value.toLowerCase();
    }
    const isActiveMW = isActiveMediaWindow();
    if (isActiveMW) {
        return;
    }

    mediaFile = opMode === MEDIAPLAYERYT ? document.getElementById("mdFile").value : webUtils.getPathForFile(document.getElementById("mdFile").files[0]);

    let imgEle = null;
    if (imgEle = document.querySelector('img')) {
        imgEle.remove();
        document.getElementById("preview").style.display = '';
        document.getElementById("cntdndiv").style.display = '';
    }
    let iM;
    if ((iM = isImg(mediaFile))) {
        playingMediaAudioOnly = false;
        audioOnlyFile = false;
    }

    if (iM && !document.querySelector('img') && (!isActiveMW)) {
        let imgEle = null;
        if ((imgEle = document.querySelector('img')) !== null) {
            imgEle.remove();
            document.getElementById("cntdndiv").style.display = '';
            if (video) {
                video.style.display = 'none';
            }
        }
        img = document.createElement('img');
        video.src = '';
        img.src = mediaFile;
        img.setAttribute("id", "preview");
        document.getElementById("preview").style.display = 'none';
        document.getElementById("preview").parentNode.appendChild(img);
        document.getElementById("cntdndiv").style.display = 'none';
        return;
    }
    let liveStream = isLiveStream(mediaFile);
    if ((mdfileElement !== null && (!isActiveMW && mdfileElement !== null &&
        !(liveStream))) || (isActiveMW && mdfileElement !== null && liveStream) || activeLiveStream && isActiveMW) {
        if (video === null) {
            video = document.getElementById('preview');
        }
        if (video) {
            if (!audioOnlyFile)
                video.muted = true;
            if (mdfileElement !== null && mdfileElement.files && prePathname !== mediaFile) {
                prePathname = mediaFile;
                startTime = 0;
            }
            if (!playingMediaAudioOnly && mdfileElement.files) {
                let uncachedLoad;
                if (uncachedLoad = encodeURI(mediaFile !== removeFileProtocol(video.src))) {
                    video.setAttribute("src", mediaFile);
                }
                video.id = "preview";
                video.currentTime = startTime;
                video.controlsList = "noplaybackrate";
                if (document.getElementById("mdLpCtlr") !== null) {
                    video.loop = document.getElementById("mdLpCtlr").checked;
                }
                if (uncachedLoad) {
                    video.load();
                }
            }
        }
    }
    if (opMode === MEDIAPLAYER && mediaFile !== null) {
        dontSyncRemote = false;
    }
}

function restoreMediaFile() {
    if (saveMediaFile.fileInpt != null && document.getElementById("mdFile") != null) {
        if (document.getElementById("YtPlyrRBtnFrmID") != null && document.getElementById("YtPlyrRBtnFrmID").checked) {
            document.getElementById("mdFile").value = saveMediaFile.urlInpt;
        } else {
            document.getElementById("mdFile").files = saveMediaFile.fileInpt;
        }
    }
}

function installEvents() {
    document.getElementById("MdPlyrRBtnFrmID").onclick = setSBFormMediaPlayer;
    document.getElementById("YtPlyrRBtnFrmID").onclick = setSBFormYouTubeMediaPlayer;
    //document.getElementById("TxtPlyrRBtnFrmID").onclick = setSBFormTextPlayer;

    document.addEventListener('keydown', (event) => {

        if ((event.ctrlKey || event.metaKey) && (event.key === 'o' || event.key === 'O')) {
            if (document.getElementById("mdFile")) {
                document.getElementById("mdFile").click();
            }
        }
    });

    document.querySelector('form').addEventListener('change', function (event) {
        if (event.target.type === 'radio') {
            if (event.target.value === 'Media Player') {
                installPreviewEventHandlers();
                dontSyncRemote = true;
                if (video && !activeLiveStream && isActiveMediaWindow()) {
                    dontSyncRemote = false;
                }
                mediaCntDnEle = document.getElementById('mediaCntDn');
                updateTimestamp(false);
                if (masterPauseState) {
                    mediaCntDnEle.textContent = savedCurTime;
                }
            } else {
                if (mediaCntDnEle)
                    savedCurTime = mediaCntDnEle.textContent;
                mediaCntDnEle = null;
            }
        }
    });
}

function playAudioFileAfterDelay() {
    video.play();
    updateTimestamp(false);
}

function playLocalMedia(event) {
    let mdly = document.getElementById("mdDelay");
    if (audioOnlyFile && mdly !== null && mdly.value > 0) {
        event.preventDefault();
        mediaPlayDelay = setTimeout(playAudioFileAfterDelay, mdly.value * 1000);
        mdly.value = 0;
        updatePlayButtonUI();
        video.pause();
        return;
    }
    mediaSessionPause = false;
    if (!audioOnlyFile && video.readyState && video.videoTracks && video.videoTracks.length === 0) {
        audioOnlyFile = true;
    }
    if (audioOnlyFile) {
        ipcRenderer.send("localMediaState", 0, "play");
        addFilenameToTitlebar(mediaFile);
        isPlaying = true;
        updatePlayButtonUI();
        updateTimestamp(false);
        let t1 = encodeURI(saveMediaFile.fileInpt[0].name);
        let t2 = removeFileProtocol(video.src).split(/[\\/]/).pop();
        if (t1 != null && t2 != null && t1 === t2) {
            document.getElementById("mdFile").files = saveMediaFile.fileInpt;
        }
    }
    if (isActiveMediaWindow()) {
        unPauseMedia(event);
        return;
    }
    let mediaScrnPlyBtn = document.getElementById("mediaWindowPlayButton");
    if (mediaScrnPlyBtn && audioOnlyFile) {
        if (isPlaying) {
            fileEnded = false;
            video.muted = false;
            if (document.getElementById("mdLpCtlr")) {
                video.loop = document.getElementById("mdLpCtlr").checked;
            }
            audioOnlyFile = true;
            playingMediaAudioOnly = true;
            updateTimestamp(false);
            return;
        }
    }
    if (isImg(video.src)) {
        return;
    }
    if (video.src === window.location.href) {
        event.preventDefault();
        return;
    }
    masterPauseState = false;
    if (isImg(video.src)) {
        audioOnlyFile = false;
        playingMediaAudioOnly = false;
    } else {
        if (audioOnlyFile) {
            video.muted = false;
            if (document.getElementById("mdLpCtlr")) {
                video.loop = document.getElementById("mdLpCtlr").checked;
            }
            if (document.getElementById('volumeControl')) {
                video.volume = document.getElementById('volumeControl').value;
            }
            playingMediaAudioOnly = true;
            updateTimestamp(false);
            return;
        }
    }
}

function loadLocalMediaHandler(event) {
    if (pidController) {
        pidController.reset();
    }
    if (video.src === window.location.href) {
        event.preventDefault();
        return;
    }
}

function loadedmetadataHandler(e) {
    if (video.src === window.location.href || isImg(video.src)) {
        return;
    }
    audioOnlyFile = video.videoTracks && video.videoTracks.length === 0;
}

function seekLocalMedia(e) {
    if (pidSeeking) {
        pidSeeking = false;
        e.preventDefault();
    }
    if (video.src === window.location.href) {
        e.preventDefault();
        return;
    }
    if (dontSyncRemote === true) {
        dontSyncRemote = false;
        return;
    }
    updateTimestamp(true);
    if (e.target.isConnected) {
        ipcRenderer.send('timeGoto-message', { currentTime: e.target.currentTime, timestamp: Date.now() });
        ipcRenderer.invoke('get-media-current-time').then(r => { targetTime = r });
    }
}

function seekingLocalMedia(e) {
    if (pidSeeking) {
        pidSeeking = false;
        e.preventDefault();
    }
    if (dontSyncRemote === true) {
        return;
    }
    updateTimestamp(true);
    if (e.target.isConnected) {
        ipcRenderer.send('timeGoto-message', { currentTime: e.target.currentTime, timestamp: Date.now() });
        ipcRenderer.invoke('get-media-current-time').then(r => { targetTime = r });
    }
}

function endLocalMedia() {
    isPlaying = false;
    updatePlayButtonUI();
    audioOnlyFile = false;
    if (document.getElementById("mediaWindowPlayButton")) {
        updatePlayButtonUI();
    }
    if (playingMediaAudioOnly) {
        video.src = '';
        playingMediaAudioOnly = false;
        if (opMode === MEDIAPLAYER) {
            document.getElementById('mediaCntDn').textContent = "00:00:00.000";
        }
        if (video) {
            video.muted = true;
        }
        if (video !== null) {
            video.currentTime = 0;
        }
        if (document.getElementById("mediaCntDn") !== null) {
            document.getElementById("mediaCntDn").innerText = "00:00:00.000";
        }

        if (document.getElementById("mediaWindowPlayButton") !== null) {
            updatePlayButtonUI();
        } else {
            document.getElementById("MdPlyrRBtnFrmID").addEventListener("click", function () {
                updatePlayButtonUI();
            }, { once: true });
        }
        masterPauseState = false;
        saveMediaFile();
    }
    targetTime = 0;
    fileEnded = true;
    ipcRenderer.send("localMediaState", 0, "stop");
    removeFilenameFromTitlebar();
    video.pause();
    masterPauseState = false;
    resetPIDOnSeek();
    if (video) {
        video.muted = true;
    }
    localTimeStampUpdateIsRunning = false;
}

function pauseLocalMedia(event) {
    if (mediaSessionPause) {
        ipcRenderer.invoke('get-media-current-time').then(r => { targetTime = r });
        return;
    }
    if (fileEnded) {
        fileEnded = false;
        return;
    }
    if (!event.target.isConnected) {
        if ((!isActiveMediaWindow()) && playingMediaAudioOnly === false) {
            return;
        }
        event.preventDefault();
        video.play().then(() => {
            isPlaying = true;
            updatePlayButtonUI();
        }).catch(error => {
            playingMediaAudioOnly = false;
        });

        masterPauseState = false;
        return;
    }
    if (event.target.clientHeight === 0) {
        event.preventDefault();
        event.target.play(); //continue to play even if detached
        return;
    }
    if (video.src === window.location.href) {
        event.preventDefault();
        return;
    }
    if (activeLiveStream) {
        return;
    }
    if (video.currentTime - video.duration === 0) {
        return;
    }
    if (event.target.parentNode !== null) {
        if (isActiveMediaWindow()) {
            pauseMedia();
            masterPauseState = true;
        }
    }
}

function installPreviewEventHandlers() {
    if (!installPreviewEventHandlers.installedVideoEventListener) {
        video.addEventListener('loadstart', loadLocalMediaHandler);
        video.addEventListener('loadedmetadata', loadedmetadataHandler);
        video.addEventListener('seeked', seekLocalMedia);
        video.addEventListener('seeking', seekingLocalMedia);
        video.addEventListener('ended', endLocalMedia);
        video.addEventListener('pause', pauseLocalMedia);
        video.addEventListener('play', playLocalMedia);
        pidController = new PIDController(video);
        installPreviewEventHandlers.installedVideoEventListener = true;
    }
}

function initPlayer() {
    ipcRenderer.invoke('get-setting', "operating-mode").then(mode => {
        dyneForm = document.getElementById("dyneForm");

        if (mode === MEDIAPLAYERYT) {
            document.getElementById("YtPlyrRBtnFrmID").checked = true;
            setSBFormYouTubeMediaPlayer();
        } else if (mode === TEXTPLAYER) {
            document.getElementById("TxtPlyrRBtnFrmID").checked = true;
            setSBFormTextPlayer();
        } else {
            document.getElementById("MdPlyrRBtnFrmID").checked = true;
            setSBFormMediaPlayer();
            installPreviewEventHandlers();
            mediaCntDnEle = document.getElementById('mediaCntDn');
        }
    });
}

function isLiveStream(mediaFile) {
    if (mediaFile === undefined || mediaFile === null) {
        return false;
    }
    return /(?:m3u8|mpd|youtube\.com|videoplayback|youtu\.be)/i.test(mediaFile);
}

async function createMediaWindow() {
    mediaFile = opMode === MEDIAPLAYERYT ? document.getElementById("mdFile").value : webUtils.getPathForFile(document.getElementById("mdFile").files[0]);
    var liveStreamMode = isLiveStream(mediaFile);

    if (liveStreamMode === false && video !== null) {
        startTime = video.currentTime;
    }

    var displays = await ipcRenderer.invoke('get-all-displays');
    var externalDisplay = null;
    externalDisplay = displays[document.getElementById("dspSelct").selectedIndex - 1];
    activeLiveStream = liveStreamMode;
    if (liveStreamMode === false) {
        if (video === null) {
            video = document.getElementById("preview");
        }
        if (video === null) {
            video.muted = true;
            video.setAttribute("src", mediaFile);
            video.id = "preview";
            video.currentTime = startTime;
            video.controlsList = "noplaybackrate";
            if (document.getElementById("mdLpCtlr") !== null) {
                video.loop = document.getElementById("mdLpCtlr").checked;
            }
            document.getElementById("cntdndiv").style.display = '';
        }
    } else {
        if (video && !isImg(video.src))
            video.src = '';
    }

    /* var strtVl = 1;
     if (document.getElementById('volumeControl') !== null) {
         strtVl = document.getElementById('volumeControl').value;
     }*/

    const isImgFile = isImg(mediaFile);

    if (audioOnlyFile && !isActiveMediaWindow()) {
        video.muted = false;
        video.loop = document.getElementById("mdLpCtlr").checked;
        //video.volume = document.getElementById('volumeControl').value;
        if (!isImgFile) {
            await video.play();
        } else {
            video.src = '';
        }
        playingMediaAudioOnly = true;
        if (playingMediaAudioOnly)
            updateTimestamp(false);
        return;
    } else {
        playingMediaAudioOnly = false;
        if (document.getElementById('mediaCntDn'))
            document.getElementById('mediaCntDn').textContent = "00:00:00.000";
        if (video) {
            video.muted = true;
        }
    }
    let strtVl = 1;
    const windowOptions = {
        backgroundColor: '#00000000',
        transparent: true,
        width: externalDisplay.width,
        height: externalDisplay.height,
        fullscreen: true,
        frame: false,
        webPreferences: {
            backgroundThrottling: false,
            additionalArguments: [
                '__mediafile-ems=' + encodeURIComponent(mediaFile),
                startTime !== 0 ? '__start-time=' + startTime : "",
                strtVl !== 1 ? '__start-vol=' + strtVl : "",
                document.getElementById("mdLpCtlr") !== null ? (document.getElementById("mdLpCtlr").checked ? '__media-loop=true' : '') : "",
                liveStreamMode ? '__live-stream=' + liveStreamMode : '', isImgFile ? "__isImg" : ""
            ],
            preload: `${__dirname}/media_preload.js`
        }
    };

    windowOptions.x = externalDisplay.bounds.x + 50;
    windowOptions.y = externalDisplay.bounds.y + 50;

    await ipcRenderer.invoke('create-media-window', windowOptions);
    isActiveMediaWindowCache = true;

    unPauseMedia();
    if (opMode !== MEDIAPLAYERYT) {
        if (video !== null && !isImgFile) {
            await video.play();
        }
    }
    addFilenameToTitlebar(mediaFile);
}

const WIN32 = 'Windows';
const LINUX = 'Linux';
const WIN_STYLE = 'WinStyle'

function loadPlatformCSS() {
    document.body.classList.add(WIN_STYLE);
}

loadPlatformCSS();
installIPCHandler();
installEvents();

ipcRenderer.once('ready', initPlayer);
