/* parcel module id: axBWq | bundle: tab-main.1e0435ca.js | bytes: 787 | separator-after: "," */
C.register("axBWq",function(e,I){var t;e.exports=(t=C("iq4P2"),C("5oat9"),/** @preserve
	 * Counter block mode compatible with  Dr Brian Gladman fileenc.c
	 * derived from CryptoJS.mode.CTR
	 * Jan Hruby jhruby.web@gmail.com
	 */t.mode.CTRGladman=function(){var e=t.lib.BlockCipherMode.extend();function I(e){if((e>>24&255)==255){var I=e>>16&255,t=e>>8&255,l=255&e;255===I?(I=0,255===t?(t=0,255===l?l=0:++l):++t):++I,e=0+(I<<16)+(t<<8)+l}else e+=16777216;return e}var l=e.Encryptor=e.extend({processBlock:function(e,t){var l,n=this._cipher,a=n.blockSize,i=this._iv,c=this._counter;i&&(c=this._counter=i.slice(0),this._iv=void 0),0===((l=c)[0]=I(l[0]))&&(l[1]=I(l[1]));var G=c.slice(0);n.encryptBlock(G,0);for(var r=0;r<a;r++)e[t+r]^=G[r]}});return e.Decryptor=l,e}(),t.mode.CTRGladman)})