param([Parameter(Mandatory=$true)][string]$ImagePath,[string]$Language='zh-Hans-CN')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1)
function Await($operation,[Type]$type){
 $task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation))
 $task.Wait()
 return $task.Result
}
$stream=$null;$bitmap=$null
try{
 $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Language))
 if($null -eq $engine){throw 'OCR language unavailable'}
 $file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
 $stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
 $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 if($decoder.PixelWidth -gt 960 -or $decoder.PixelHeight -gt 960){throw 'OCR image exceeds 960px bound'}
 $bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
 $watch=[Diagnostics.Stopwatch]::StartNew()
 $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
 $watch.Stop()
 $words=@();foreach($line in $result.Lines){foreach($word in $line.Words){
  if($words.Count -lt 2000){$r=$word.BoundingRect;$words+=@{text=$word.Text;x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}}
 }}
 @{text=$result.Text;language=$engine.RecognizerLanguage.LanguageTag;width=$decoder.PixelWidth;height=$decoder.PixelHeight;words=$words;recognitionMs=$watch.ElapsedMilliseconds;confidence=$null;engine='Windows.Media.Ocr';osVersion=[Environment]::OSVersion.Version.ToString()} | ConvertTo-Json -Depth 6 -Compress
}finally{if($null -ne $bitmap){$bitmap.Dispose()};if($null -ne $stream){$stream.Dispose()}}
