const canvas = document.getElementById("whiteboard");
//const canvas2 = document.getElementById("saved-image");

//const clearButton = document.getElementById("clear");
const drawModeButton = document.getElementById("pencil");
const eraserModeButton = document.getElementById("eraser");
//const saveImageButton = document.getElementById("save");
//const sendImageButton = document.getElementById("send");

const canvasContext = canvas.getContext("2d");
//const canvasContext2 = canvas2.getContext("2d");

canvas.width = window.innerWidth * 0.71;
canvas.height = window.innerHeight * 0.85;

let isDrawing = false;
let mousePosition = {x: 0, y: 0};
const pencilModes = {DRAW: 0, ERASE: 1};
let pencilMode = pencilModes.DRAW;

let previousDrawing = new Image();

function clearCanvas()
{
    canvas.width = canvas.width;
    canvas.height = canvas.height;

    pencilMode = pencilModes.DRAW;
}

/*function clearCanvasOld()
{
    canvas.width = canvas.width;
    canvas.height = canvas.height;

    canvasContext.drawImage(previousDrawing, 0, 0);

    pencilMode = pencilModes.DRAW;
}*/

// Force the Start Game button to always show for testing
function forceHostButton() {
    const startButton = document.getElementById('startGameButton');
    if (!startButton) return;

    // Make the button visible
    startButton.style.display = 'block';
    startButton.disabled = false;

    // Optional: make it clickable for testing
    startButton.addEventListener('click', () => {
        console.log('Start Game button clicked (forced host mode)');
        // Trigger your usual start game WebSocket message
        if (window.ws) window.ws.send(JSON.stringify({ type: 'start-game' }));
    });
}

// Call it immediately for testing
forceHostButton();

function continueDrawing(event)
{
    if (!isDrawing)
    {
        return;
    }

    createStroke(mousePosition.x, mousePosition.y, event.offsetX, event.offsetY);
    mousePosition.x = event.offsetX;
    mousePosition.y = event.offsetY;
}

function createStroke(currentX, currentY, futureX, futureY)
{
    canvasContext.beginPath();

    canvasContext.lineCap = "round";
    canvasContext.lineJoin = "round";

    switch (pencilMode)
    {
        case pencilModes.DRAW:
            canvasContext.lineWidth = 5;
            canvasContext.strokeStyle = "rgba(0, 0, 0, 1)";
            canvasContext.globalCompositeOperation = "source-over";

            break;
        case pencilModes.ERASE:
            canvasContext.lineWidth = 80;
            canvasContext.strokeStyle = "rgba(0, 0, 0, 1)";
            canvasContext.globalCompositeOperation = "destination-out";

            break;
        default:
            console.log("Brother, what are you doing...");
    }

    canvasContext.moveTo(currentX, currentY);
    canvasContext.lineTo(futureX, futureY);
    canvasContext.closePath();

    canvasContext.stroke();
}

function getAndRecordMousePosition(event)
{
    mousePosition.x = event.offsetX; //event.clientX - canvas.offsetLeft;
    mousePosition.y = event.offsetY; //event.clientY - canvas.offsetTop;
}

function saveAndShowDrawnImage()
{
    //let newImage = new Image();
    previousDrawing.src = canvas.toDataURL();
    previousDrawing.onload = function()
    {
        canvasContext.drawImage(previousDrawing, 0, 0);
    }
}

function sendImage()
{
    //canvasContext.drawImage(previousDrawing, 0, 0);

    const image = previousDrawing.src;
    if (image && window.ws) {
        window.ws.send(image);
    }
}

function startDrawing(event)
{
    mousePosition.x = event.offsetX;
    mousePosition.y = event.offsetY;
    isDrawing = true;
}

function stopDrawing()
{
    isDrawing = false;
}

function switchToDrawingMode()
{
    pencilMode = pencilModes.DRAW;
}

function switchToErasingMode()
{
    pencilMode = pencilModes.ERASE;
}

canvas.addEventListener('mousedown', (event) =>
{
    startDrawing(event);
});

canvas.addEventListener('mousemove', (event) =>
{
    continueDrawing(event);
});

canvas.addEventListener('mouseup', (event) =>
{
    stopDrawing();
});

/*clearButton.addEventListener("click", () => {
    clearCanvas();
});*/

drawModeButton.addEventListener("click", () => {
    switchToDrawingMode();
});

eraserModeButton.addEventListener("click", () => {
    switchToErasingMode();
});

/*saveImageButton.addEventListener("click", () => {
    saveAndShowDrawnImage();
});

sendImageButton.addEventListener("click", () => {
    sendImage();
});*/
