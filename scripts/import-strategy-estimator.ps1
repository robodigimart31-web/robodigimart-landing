param(
  [Parameter(Mandatory = $false)]
  [string]$WorkbookPath = (Join-Path $PSScriptRoot '..\..\HELIX_QUADRIGA_V19C_ESTIMATOR_STREAK_FIXED_OPT1-3_20261023.xlsx'),
  [Parameter(Mandatory = $false)]
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\functions\vip\api\strategy-estimator-source.js')
)

$ErrorActionPreference = 'Stop'
$WorkbookPath = (Resolve-Path -LiteralPath $WorkbookPath).Path
$sourceHash = (Get-FileHash -LiteralPath $WorkbookPath -Algorithm SHA256).Hash.ToLowerInvariant()
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false
$book = $null

try {
  $book = $excel.Workbooks.Open($WorkbookPath, 0, $true)
  $base = $book.Worksheets.Item('03_Base_Data').Range('A5:AD297').Value2
  $combo = $book.Worksheets.Item('01_Mode_Equity').Range('A16:Q30').Value2
  $risk = $book.Worksheets.Item('07_Risk_Audit').Range('A5:I19').Value2
  $lots = $book.Worksheets.Item('06_Lot_Calibration').Range('A5:G16').Value2
  $assumptions = $book.Worksheets.Item('01_Mode_Equity').Range('I5:I12').Value2

  $days = [System.Collections.Generic.List[object]]::new()
  for ($row = 1; $row -le 293; $row++) {
    $families = @(
      ,@([int]($base[$row, 2]), [int]($base[$row, 3]), [int]($base[$row, 4]), [double]($base[$row, 6]))
      ,@([int]($base[$row, 7]), [int]($base[$row, 8]), [int]($base[$row, 9]), [double]($base[$row, 11]))
      ,@([int]($base[$row, 12]), [int]($base[$row, 13]), [int]($base[$row, 14]), [double]($base[$row, 16]))
      ,@([int]($base[$row, 17]), [int]($base[$row, 18]), [int]($base[$row, 19]), [double]($base[$row, 21]))
    )
    $days.Add([ordered]@{
      date = [DateTime]::FromOADate([double]($base[$row, 1])).ToString('yyyy-MM-dd')
      families = $families
    })
  }

  $combinations = [System.Collections.Generic.List[object]]::new()
  for ($row = 1; $row -le 15; $row++) {
    $combinations.Add([ordered]@{
      name = [string]($combo[$row, 1])
      closedTrades = [int]($combo[$row, 2])
      winRate = [double]($combo[$row, 3])
      profitFactor = [double]($combo[$row, 4])
      netPips = [double]($combo[$row, 5])
      maxLossDays = [int]($combo[$row, 7])
      worstStreakLoss = [double]($risk[$row, 3])
      worstDailyLoss = [double]($risk[$row, 4])
      peakOpen = [int]($combo[$row, 11])
      realizedDrawdownPips = [double]($combo[$row, 12])
    })
  }

  $calibration = [System.Collections.Generic.List[object]]::new()
  for ($row = 1; $row -le 12; $row++) {
    $calibration.Add([ordered]@{
      lot = ([double]($lots[$row, 1])).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
      netProfit = [double]($lots[$row, 4])
      pfReference = [double]($lots[$row, 5])
      status = [string]($lots[$row, 6])
    })
  }

  $model = [ordered]@{
    source = 'HELIX_QUADRIGA_V19C_ESTIMATOR_STREAK_FIXED_OPT1-3_20261023.xlsx'
    sourceSha256 = $sourceHash
    period = @('2026-01-01', '2026-10-20')
    families = @('ML', 'RL', 'SHL', 'LGL')
    days = $days.ToArray()
    combinations = $combinations.ToArray()
    calibration = $calibration.ToArray()
    assumptions = @{
      baseLot = [double]($assumptions[1, 1])
      xauPrice = [double]($assumptions[2, 1])
      leverage = [double]($assumptions[3, 1])
      pnlMultiplier = [double]($assumptions[4, 1])
      marginLevel = [double]($assumptions[5, 1])
      buffer = [double]($assumptions[6, 1])
      equityDdMultiplier = [double]($assumptions[7, 1])
      roundUp = [double]($assumptions[8, 1])
    }
  }

  $json = ConvertTo-Json -InputObject $model -Depth 12 -Compress
  $module = "export const STRATEGY_ESTIMATOR_SOURCE = $json;`n"
  [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($OutputPath), $module, [System.Text.UTF8Encoding]::new($false))
  Write-Output "Imported $($days.Count) days, $($combinations.Count) combinations, and $($calibration.Count) lots."
  Write-Output "Workbook SHA-256: $sourceHash"
} finally {
  if ($book) { $book.Close($false) }
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
