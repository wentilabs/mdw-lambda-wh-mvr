// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
//
// This module previously held a parallel evening-only NM02 sheet writer
// (`updateNoiseDataToSheet` + its time/format helpers). That path was dead —
// superseded by sheets-direct.js. Only `findOrCreateSheet` is still used (by
// sheets-direct.js), so it's all that remains here.

const { duplicateSheet, readGoogleSheet } = require("../../utils/gsheet");

/**
 * Find or create sheet for the given date.
 *
 * @param {string} spreadsheetId - The ID of the Google spreadsheet
 * @param {string} sheetName - The sheet name (formatted as DD/MM/YYYY)
 * @param {string} templateSheetName - The template sheet name to duplicate (default: 'Template v2')
 * @returns {Promise<boolean>} - True if sheet exists or was created, false otherwise
 */
async function findOrCreateSheet(spreadsheetId, sheetName, templateSheetName = "Template v2") {
  try {
    console.log(`Checking if sheet "${sheetName}" exists...`);

    // Try to read the sheet to see if it exists
    let sheetData;
    try {
      sheetData = await readGoogleSheet(spreadsheetId, sheetName);
    } catch (error) {
      console.log(`Error reading sheet: ${error.message}`);
      sheetData = null;
    }

    if (sheetData) {
      console.log(`Sheet "${sheetName}" already exists.`);
      return true;
    }

    console.log(`Sheet "${sheetName}" not found. Creating from template "${templateSheetName}"...`);

    // Check if template exists
    let templateData;
    try {
      templateData = await readGoogleSheet(spreadsheetId, templateSheetName);
      if (!templateData) {
        console.error(`Template sheet "${templateSheetName}" not found. Cannot create new sheet without template.`);
        return false;
      }
    } catch (error) {
      console.error(`Error reading template "${templateSheetName}": ${error.message}`);
      return false;
    }

    await duplicateSheet(spreadsheetId, templateSheetName, sheetName);
    console.log(`Created new sheet "${sheetName}" from template "${templateSheetName}".`);

    return true;
  } catch (error) {
    console.error(`Error finding or creating sheet "${sheetName}":`, error);
    return false;
  }
}

module.exports = {
  findOrCreateSheet,
};
