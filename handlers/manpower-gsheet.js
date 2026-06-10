const { getAuth } = require("../utils/gsheet");
const { sheets: createSheets } = require("@googleapis/sheets");

/**
 * Format the Date cell (column A) in a manpower/machines sheet row to yyyy-mm-dd.
 * Isolated to manpower use case to avoid changing shared gsheet utilities.
 */
async function formatDateCell(spreadsheetId, sheetName, rowIndex, colIndex = 0) {
  const sheets = createSheets({ version: "v4", auth: getAuth() });
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: sheet.properties.sheetId,
              startRowIndex: rowIndex - 1,
              endRowIndex: rowIndex,
              startColumnIndex: colIndex,
              endColumnIndex: colIndex + 1,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    },
  });
}

module.exports = {
  formatDateCell,
};
