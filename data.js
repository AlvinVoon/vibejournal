const vscode = require('vscode');

/**
 * Reads and parses JSON data from a file inside the extension's global storage directory.
 * Returns `undefined` if the file doesn't exist.
 * @param {import('vscode').ExtensionContext} context
 * @param {string} fileName
 */
async function readGlobalStorageData(context, fileName) {
  const fileUri = vscode.Uri.joinPath(context.globalStorageUri, fileName);

  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const json = Buffer.from(bytes).toString('utf8');
    return JSON.parse(json);
  } catch (err) {
    // File doesn't exist or couldn't be read/parsed
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return undefined;
    }
    throw err;
  }
}

/**
 * Writes data to a JSON file inside the extension's global storage directory.
 * Creates the directory if it doesn't exist yet.
 * @param {import('vscode').ExtensionContext} context
 * @param {string} fileName
 * @param {*} data
 */
async function writeGlobalStorageData(context, fileName, data) {
  const today = new Date();
  const isoDate = today.toISOString().split('T')[0];

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  // Read existing data (if any) and normalize to a 2D array
  const previousData = await readGlobalStorageData(context, fileName);
  const updatedData = Array.isArray(previousData) ? previousData : [];

  // Find today's group, if it exists
  const todayGroup = updatedData.find(group => group[0] === isoDate);

  if (todayGroup) {
    // Append to today's existing entries
    todayGroup.push(data);
  } else {
    // Start a new group for today
    updatedData.push([isoDate, data]);
  }

  const fileUri = vscode.Uri.joinPath(context.globalStorageUri, fileName);
  const json = JSON.stringify(updatedData, null, 2);
  const bytes = Buffer.from(json, 'utf8');

  await vscode.workspace.fs.writeFile(fileUri, bytes);

  console.log(fileUri);
}

module.exports = {
  readGlobalStorageData,
  writeGlobalStorageData
};