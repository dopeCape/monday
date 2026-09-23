// Mail the way senders actually write it, for the sanitizer and MIME tests.

/** A newsletter the way ESPs send it: a head with a <style> block, nested layout tables, inline styles, remote images. */
export const NEWSLETTER = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>The Weekly</title>
<link rel="stylesheet" href="https://fonts.example.com/css?family=Inter">
<style type="text/css">
  @import url("https://fonts.example.com/inter.css");
  @font-face { font-family: Inter; src: url(https://fonts.example.com/inter.woff2); }
  body { margin: 0; padding: 0; background-color: #f4f4f4; }
  .container { width: 600px; }
  h1.title, .hero td { color: #1a1a1a; font-family: Inter, Helvetica, Arial, sans-serif; }
  .banner { background-image: url(https://cdn.example.com/banner.png); }
  a:hover { position: fixed; color: red; }
  @media only screen and (max-width: 620px) { .container { width: 100% !important; } }
  @keyframes spin { from { opacity: 0; } }
</style>
</head>
<body bgcolor="#f4f4f4" style="margin:0">
<!-- preheader -->
<div style="display:none;max-height:0;overflow:hidden">This week in review</div>
<center>
<table role="presentation" class="container" width="600" align="center" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-collapse:collapse;margin:0 auto">
  <tr>
    <td class="banner" background="https://cdn.example.com/bg.jpg" valign="top" height="120" style="background:#333 url('https://cdn.example.com/bg.jpg') no-repeat center;padding:24px 32px">
      <img src="https://cdn.example.com/logo.png" srcset="https://cdn.example.com/logo.png 1x, https://cdn.example.com/logo@2x.png 2x" width="120" height="40" alt="The Weekly" border="0" style="display:block">
    </td>
  </tr>
  <tr class="hero">
    <td align="left" valign="top" style="padding:32px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#333333;text-align:left">
      <h1 class="title" style="margin:0 0 16px;font-size:28px">Hello, reader</h1>
      <p><font face="Georgia, serif" color="#666666" size="2">Set in Georgia.</font></p>
      <a href="https://example.com/read?utm=1" style="background-color:#0066ff;color:#ffffff;border-radius:4px;padding:12px 24px;display:inline-block;text-decoration:none">Read more</a>
      <img src="cid:chart@example.com" width="560" alt="Chart" data-src="https://tracker.example/pixel">
    </td>
  </tr>
</table>
</center>
<img src="https://tracker.example/open.gif" width="1" height="1" alt="">
</body></html>`;
