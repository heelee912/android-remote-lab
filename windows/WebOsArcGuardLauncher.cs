using System;
using System.Diagnostics;
using System.IO;

internal static class WebOsArcGuardLauncher
{
    private static int Main(string[] args)
    {
        if (args.Length != 2 || !File.Exists(args[0]) || !File.Exists(args[1]))
        {
            return 2;
        }

        try
        {
            var start = new ProcessStartInfo
            {
                FileName = args[0],
                Arguments = "\"" + args[1] + "\" webos guard once",
                WorkingDirectory = Path.GetDirectoryName(args[1]),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using (var process = new Process { StartInfo = start })
            {
                process.OutputDataReceived += (sender, line) => { };
                process.ErrorDataReceived += (sender, line) => { };
                if (!process.Start()) return 3;
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch
        {
            return 3;
        }
    }
}
